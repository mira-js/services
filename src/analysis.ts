import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CollectedItem, ExtractionResult, PainPointTheme, Result } from '@mira/shared-core'
import { BatchError } from '@mira/shared-core'
import { recordEmbeddingRequest } from '@mira/shared-core/usage-scope'
import { callLLM } from './llm.js'
import type { LLMUsageSink } from './llm-usage.js'

// ─── Zod schemas ──────────────────────────────────────────────────────────────

export const ExtractionResultSchema = z.object({
  pain_points: z.array(z.string()),
  sentiment: z.number().min(-1).max(1),
  category: z.enum(['complaint', 'feature-request', 'workflow-friction', 'pricing', 'switching-signal', 'integration-issue', 'comparison', 'workaround', 'information-seeking']),
  mentioned_tools: z.array(z.string()),
  key_quote: z.string(),
})

const BatchExtractionResultSchema = z.array(ExtractionResultSchema)

const JinaResponseSchema = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
})

// ─── Prompt helpers ───────────────────────────────────────────────────────────

const PROMPTS_DIR = process.env.MIRA_PROMPTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../../../prompts')

function loadPrompt(filename: string): string {
  return readFileSync(join(PROMPTS_DIR, filename), 'utf8')
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v), template)
}

/**
 * The exact template string `extractBatch` fills, so a caller can hash the same
 * text for a cache key without resolving `PROMPTS_DIR` a third time.
 */
export function loadExtractionTemplate(): string {
  return loadPrompt('extract_pain_points.txt')
}

export function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim()
}

// ─── PL-2 Phase 0a diagnostic instrumentation (temporary, env-gated) ──────────
// Gated behind MIRA_DEBUG_LLM_RAW because raw LLM bodies echo user-submitted
// post content. Off by default. Fate resolved in Phase 0b (AC-5).

function debugLog(payload: Record<string, unknown>): void {
  if (process.env.MIRA_DEBUG_LLM_RAW !== '1') return
  console.info(JSON.stringify({ event: 'pl2_debug', site: 'extractBatch', ...payload }))
}

if (process.env.MIRA_DEBUG_LLM_RAW === '1') {
  console.info(
    JSON.stringify({
      event: 'pl2_sentinel',
      message: 'pl2-phase0a instrumentation active',
      module: 'mira-core/packages/core-services/analysis.ts',
      resolvedFrom: 'dist',
    }),
  )
}

// ─── Jina embeddings ──────────────────────────────────────────────────────────

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (!process.env.JINA_API_KEY) {
    throw new Error('JINA_API_KEY is required for embeddings')
  }
  const res = await fetch('https://api.jina.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'jina-embeddings-v4',
      task: 'text-matching',
      input: texts,
    }),
  })
  if (!res.ok) {
    throw new Error(`Jina embeddings failed: ${res.status} ${res.statusText}`)
  }
  recordEmbeddingRequest()
  const parsed = JinaResponseSchema.parse(await res.json())
  return parsed.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
}

// ─── Clustering helpers ───────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0)
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
  if (magA === 0 || magB === 0) return 0
  return dot / (magA * magB)
}

type ClusterState<T> = { clusters: T[][]; assignedIndices: ReadonlySet<number> }

function greedyCluster<T>(items: T[], embeddings: number[][], threshold: number): T[][] {
  const { clusters } = items.reduce<ClusterState<T>>(
    ({ clusters, assignedIndices }, item, i) => {
      if (assignedIndices.has(i)) return { clusters, assignedIndices }

      const { members, newAssigned } = items.reduce<{ members: T[]; newAssigned: Set<number> }>(
        (acc, candidate, j) => {
          if (j === i || acc.newAssigned.has(j) || assignedIndices.has(j)) return acc
          if (cosineSimilarity(embeddings[i], embeddings[j]) >= threshold) {
            return { members: [...acc.members, candidate], newAssigned: new Set([...acc.newAssigned, j]) }
          }
          return acc
        },
        { members: [item], newAssigned: new Set([i]) },
      )

      return {
        clusters: [...clusters, members],
        assignedIndices: new Set([...assignedIndices, ...newAssigned]),
      }
    },
    { clusters: [], assignedIndices: new Set() },
  )

  return clusters
}

// ─── Theme synthesis ──────────────────────────────────────────────────────────

async function synthesizeThemeLabel(
  cluster: ExtractionPair[],
  onUsage?: LLMUsageSink,
): Promise<Result<string>> {
  const bullets = cluster
    .slice(0, 5)
    .map((p) => '- ' + (p.extraction.pain_points[0] ?? p.extraction.key_quote))
    .join('\n')

  const prompt =
    'You are labelling a cluster of related user pain points.\n' +
    'Write a 3–6 word label in Title Case that captures the shared theme.\n' +
    'Return ONLY the label — no quotes, no trailing punctuation, no commentary.\n\n' +
    'Pain points:\n' + bullets

  const raw = await callLLM(
    [{ role: 'user', content: prompt }],
    { maxTokens: 20, temperature: 0, ...(onUsage ? { onUsage } : {}) },
  )

  const cleaned = raw.trim().replace(/^["'`]+|["'`.!?]+$/g, '').trim()
  if (!cleaned) {
    return { ok: false, error: new Error('Empty label from LLM') }
  }
  return { ok: true, value: cleaned }
}

// ─── Exported functions ───────────────────────────────────────────────────────

export async function extractBatch(
  items: CollectedItem[],
): Promise<Result<ExtractionResult, BatchError>[]> {
  if (!items.length) return []

  let rawResponse = ''

  try {
    const itemsJson = items.map((item) => ({
      title: item.title,
      body: item.body,
      replies: item.raw_replies.slice(0, 5),
      source: item.source,
    }))
    const template = loadExtractionTemplate()
    const prompt = fillTemplate(template, { items: JSON.stringify(itemsJson, null, 2) })
    const raw = await callLLM([{ role: 'user', content: prompt }], {
      maxTokens: 1024 * items.length,
      temperature: 0,
    })
    rawResponse = raw
    const parsed: unknown = JSON.parse(stripFences(raw))
    const validated = BatchExtractionResultSchema.parse(parsed)

    if (validated.length !== items.length) {
      debugLog({
        path: 'length-mismatch',
        itemCount: items.length,
        resultCount: validated.length,
        rawLength: rawResponse.length,
        raw: rawResponse,
      })
      return items.map((item, index) => ({
        ok: false as const,
        error: new BatchError(
          `length-mismatch: LLM returned ${validated.length} results for ${items.length} items`,
          index,
          item,
        ),
      }))
    }

    return validated.map((result) => ({ ok: true as const, value: result }))
  } catch (error) {
    const tag =
      error instanceof z.ZodError
        ? 'schema-error'
        : error instanceof SyntaxError
          ? 'parse-error'
          : 'llm-error'
    const baseMessage = error instanceof Error ? error.message : String(error)
    const errorMessage = `${tag}: ${baseMessage}`

    debugLog({
      path: tag,
      itemCount: items.length,
      rawLength: rawResponse.length,
      raw: rawResponse,
      ...(error instanceof z.ZodError ? { zodIssues: JSON.stringify(error.issues) } : {}),
    })

    return items.map((item, index) => ({
      ok: false as const,
      error: new BatchError(errorMessage, index, item),
    }))
  }
}

export async function extractItem(item: CollectedItem): Promise<Result<ExtractionResult>> {
  const results = await extractBatch([item])
  const result = results[0]
  if (!result) {
    return { ok: false, error: new Error('No result from batch') }
  }
  if (result.ok) {
    return { ok: true, value: result.value }
  }
  return { ok: false, error: result.error }
}

type ExtractionPair = { item: CollectedItem; extraction: ExtractionResult }

function clusterByStringDedup(pairs: ExtractionPair[]): ExtractionPair[][] {
  const seen = pairs.reduce<Map<string, ExtractionPair[]>>((acc, pair) => {
    const key = pair.extraction.key_quote
    return acc.set(key, [...(acc.get(key) ?? []), pair])
  }, new Map())
  return Array.from(seen.values())
}

export async function aggregateThemes(
  pairs: ExtractionPair[],
  options?: { skipEmbeddings?: boolean; onUsage?: LLMUsageSink },
): Promise<Result<PainPointTheme[]>> {
  try {
    if (pairs.length === 0) return { ok: true, value: [] }

    const clusters = options?.skipEmbeddings
      ? clusterByStringDedup(pairs)
      : greedyCluster(
          pairs,
          await getEmbeddings(
            pairs.map((p) => p.extraction.pain_points.join(' ') + ' ' + p.extraction.key_quote),
          ),
          0.75,
        )

    const built = await Promise.all(
      clusters.map(async (cluster) => {
        const avgSentiment =
          cluster.reduce((sum, p) => sum + Math.max(-1, Math.min(1, p.extraction.sentiment)), 0) /
          cluster.length

        const rawTheme = cluster[0].extraction.key_quote
        const labelResult = await synthesizeThemeLabel(cluster, options?.onUsage)
        const synthesized_name = labelResult.ok ? labelResult.value : undefined

        return {
          theme: rawTheme,
          ...(synthesized_name ? { synthesized_name } : {}),
          frequency: cluster.length,
          sources: [...new Set(cluster.map((p) => p.item.source))],
          sentiment: avgSentiment,
          evidence: cluster.slice(0, 3).map((p) => ({
            source: p.item.source,
            url: p.item.url,
            excerpt: p.extraction.key_quote,
          })),
        } satisfies PainPointTheme
      }),
    )

    return {
      ok: true,
      value: built.sort((a, b) => b.frequency - a.frequency),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

export async function synthesizeReport(
  query: string,
  themes: { painPoints: PainPointTheme[]; competitorWeaknesses: PainPointTheme[]; emergingGaps: PainPointTheme[] },
): Promise<Result<string>> {
  try {
    const template = loadPrompt('synthesize_report.txt')
    const prompt = fillTemplate(template, { query, themes: JSON.stringify(themes, null, 2) })
    const value = await callLLM([{ role: 'user', content: prompt }], { maxTokens: 2048, temperature: 0.2 })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}
