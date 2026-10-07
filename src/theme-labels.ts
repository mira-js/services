// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import type { CollectedItem, ExtractionResult, Result } from '@mira/shared-core'
import { logger } from '@mira/shared-core/logger'
import { callLLM } from './llm.js'
import type { LLMUsageSink } from './llm-usage.js'
import { mapWithConcurrency } from './concurrency.js'
import { loadPromptWithBundledFallback } from './prompt-files.js'
import {
  computeAnalysisCacheKey,
  computeAnalysisPromptVersion,
  readAnalysisCache,
  resolveModelName,
  writeAnalysisCache,
} from './llm-cache.js'
import type { AnalysisCacheReadResult, AnalysisCacheWriteRow } from './llm-cache.js'

/** Opt-in cache for `aggregateThemes` (ADR-013, amended 2026-10-07). */
export type ThemeCacheOptions = { bust?: boolean }

type ExtractionPair = { item: CollectedItem; extraction: ExtractionResult }

const THEME_LABEL_PROMPT = 'theme_label.txt'

// Upper bound on in-flight label-synthesis LLM calls per labelClusters call.
// String-dedup clustering yields roughly one cluster per item, so an unbounded
// fan-out would fire one concurrent call per item.
const LABEL_CONCURRENCY = 5

const CachedLabelSchema = z.string().min(1)

/** `MIRA_PROMPTS_DIR/theme_label.txt`, else the copy bundled with mira-core. Throws if both are missing. */
export function loadThemeLabelTemplate(): string {
  return loadPromptWithBundledFallback(THEME_LABEL_PROMPT)
}

/**
 * Not `fillTemplate`: its `replaceAll` takes a string replacement, which would
 * rewrite `$&` and `$$` inside a bullet. A trailing newline on the file is dropped
 * so the prompt matches the former inline string byte for byte.
 */
export function renderThemeLabelPrompt(template: string, bullets: string): string {
  return template.replace(/\n+$/, '').split('{{bullets}}').join(bullets)
}

function bulletLinesOf(cluster: ExtractionPair[]): string[] {
  return cluster
    .slice(0, 5)
    .map((p) => '- ' + (p.extraction.pain_points[0] ?? p.extraction.key_quote))
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function synthesizeThemeLabel(prompt: string, onUsage?: LLMUsageSink): Promise<Result<string>> {
  // A rejected label call must not escape: it would reject the whole bucket.
  const rawResult = await callLLM(
    [{ role: 'user', content: prompt }],
    { maxTokens: 32, temperature: 0, ...(onUsage ? { onUsage } : {}) },
  ).then(
    (value): Result<string> => ({ ok: true, value }),
    (error: unknown): Result<string> => ({ ok: false, error: toError(error) }),
  )
  if (!rawResult.ok) return rawResult

  const cleaned = rawResult.value.trim().replace(/^["'`]+|["'`.!?]+$/g, '').trim()
  if (!cleaned) {
    return { ok: false, error: new Error('Empty label from LLM') }
  }
  return { ok: true, value: cleaned }
}

function warnCacheUnavailable(reason: string): void {
  logger.warn('llm_cache_unavailable', { kind: 'label', reason })
}

function logCacheStats(hits: number, misses: number): void {
  if (process.env.MIRA_LOG_LLM_USAGE !== '1') return
  logger.info('llm_cache', { event: 'llm_cache', kind: 'label', hits, misses })
}

async function safeRead(keys: string[]): Promise<Map<string, string>> {
  const read: AnalysisCacheReadResult<string> = await readAnalysisCache(keys, CachedLabelSchema).catch(
    (error: unknown): AnalysisCacheReadResult<string> => ({ hits: new Map(), error: toError(error) }),
  )
  if (read.error) warnCacheUnavailable(`read: ${read.error.message}`)
  return read.hits
}

async function safeWrite(rows: AnalysisCacheWriteRow[]): Promise<void> {
  const res: Result<void> = await writeAnalysisCache(rows).catch(
    (error: unknown): Result<void> => ({ ok: false, error: toError(error) }),
  )
  if (!res.ok) warnCacheUnavailable(`write: ${res.error.message}`)
}

function loadTemplateOrWarn(): string | undefined {
  try {
    return loadThemeLabelTemplate()
  } catch (error) {
    logger.warn('theme_label_prompt_unavailable', { reason: toError(error).message })
    return undefined
  }
}

/**
 * One label per cluster, index-aligned; a failed or empty label is `undefined`.
 * Never rejects. With `cache`, labels are read in one batch (skipped on `bust`),
 * only misses call the LLM, and the cleaned labels are written in one batch.
 */
export async function labelClusters(
  clusters: ExtractionPair[][],
  opts?: { onUsage?: LLMUsageSink; cache?: ThemeCacheOptions },
): Promise<Array<string | undefined>> {
  if (!clusters.length) return []
  const template = loadTemplateOrWarn()
  if (template === undefined) return clusters.map(() => undefined)

  const bulletLines = clusters.map(bulletLinesOf)
  const cache = opts?.cache
  const model = cache ? resolveModelName() : ''
  const keys = cache
    ? bulletLines.map((payload) => computeAnalysisCacheKey({ kind: 'label', template, model, payload }))
    : []
  const hits = cache && !cache.bust ? await safeRead([...new Set(keys)]) : new Map<string, string>()

  const labels: Array<string | undefined> = clusters.map((_, i) => (cache ? hits.get(keys[i]) : undefined))
  const missIndices = labels.flatMap((label, i) => (label === undefined ? [i] : []))
  if (cache) logCacheStats(clusters.length - missIndices.length, missIndices.length)

  const fresh = await mapWithConcurrency(missIndices, LABEL_CONCURRENCY, (i) =>
    synthesizeThemeLabel(renderThemeLabelPrompt(template, bulletLines[i].join('\n')), opts?.onUsage),
  )

  const rows: AnalysisCacheWriteRow[] = []
  const promptVersion = computeAnalysisPromptVersion(template)
  missIndices.forEach((clusterIndex, j) => {
    const result = fresh[j]
    if (!result.ok) return
    labels[clusterIndex] = result.value
    if (cache) rows.push({ cacheKey: keys[clusterIndex], kind: 'label', promptVersion, model, result: result.value })
  })
  if (rows.length) await safeWrite(rows)

  return labels
}
