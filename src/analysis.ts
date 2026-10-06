// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CollectedItem, ExtractionResult, PainPointTheme, Result } from '@mira/shared-core'
import { BatchError } from '@mira/shared-core'
import { recordEmbeddingRequest } from '@mira/shared-core/usage-scope'
import { logger } from '@mira/shared-core/logger'
import { callLLM } from './llm.js'
import type { LLMMessage, LLMResponseFormat } from './llm.js'
import { selectSynthesisInput, findMissingSections } from './synthesis-input.js'
import { stripFences } from './strip-fences.js'
import type { ThemeBuckets, SynthesisSample, SynthesisBucket, SynthesisInput } from './synthesis-input.js'
import { parseSynthesisReply, renderReportMarkdown } from './synthesis-report.js'
import type { SynthesisParseError, SynthesisReport } from './synthesis-report.js'
import { debugRawEnabled } from './debug.js'
import { mapWithConcurrency } from './concurrency.js'
import { fetchWithRetryOn429 } from './jina-retry.js'
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

export { stripFences }

// ─── PL-2 Phase 0a diagnostic instrumentation (temporary, env-gated) ──────────
// Gated behind MIRA_DEBUG_LLM_RAW because raw LLM bodies echo user-submitted
// post content. Off by default. Fate resolved in Phase 0b (AC-5).

function debugLog(payload: Record<string, unknown>): void {
  if (!debugRawEnabled()) return
  logger.info('pl2_debug', { event: 'pl2_debug', site: 'extractBatch', ...payload })
}

if (debugRawEnabled()) {
  logger.info('pl2_sentinel', {
    event: 'pl2_sentinel',
    message: 'pl2-phase0a instrumentation active',
    module: 'mira-core/packages/core-services/analysis.ts',
    resolvedFrom: 'dist',
  })
}

// ─── Jina embeddings ──────────────────────────────────────────────────────────

// Wraps a network-level fetch throw so the message carries the underlying
// cause (for example ECONNRESET). The request/response body is never included.
async function fetchEmbeddings(apiKey: string, texts: string[]): Promise<Response> {
  try {
    return await fetch('https://api.jina.ai/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'jina-embeddings-v4',
        task: 'text-matching',
        input: texts,
      }),
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const causeMsg = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
    throw new Error(`Jina embeddings request failed: ${msg}${causeMsg ? ` (cause: ${causeMsg})` : ''}`)
  }
}

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.JINA_API_KEY
  if (!apiKey) {
    throw new Error('JINA_API_KEY is required for embeddings')
  }
  const res = await fetchWithRetryOn429(() => fetchEmbeddings(apiKey, texts))
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

  // A rejected label call must not escape: it would reject the whole bucket.
  const rawResult = await callLLM(
    [{ role: 'user', content: prompt }],
    { maxTokens: 32, temperature: 0, ...(onUsage ? { onUsage } : {}) },
  ).then(
    (value): Result<string> => ({ ok: true, value }),
    (error: unknown): Result<string> => ({
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    }),
  )
  if (!rawResult.ok) return rawResult

  const cleaned = rawResult.value.trim().replace(/^["'`]+|["'`.!?]+$/g, '').trim()
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

// Upper bound on in-flight label-synthesis LLM calls per aggregateThemes call.
// String-dedup clustering yields roughly one cluster per item, so an unbounded
// fan-out would fire one concurrent call per item.
const LABEL_CONCURRENCY = 5

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

    const built = await mapWithConcurrency(clusters, LABEL_CONCURRENCY, async (cluster) => {
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
    })

    return {
      ok: true,
      value: built.sort((a, b) => b.frequency - a.frequency),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

const SYNTHESIS_MAX_TOKENS = 4096
const SYNTHESIS_RETRY_MAX_TOKENS = 8192

type LLMReplyFailure = { reason: string | null; finishReason: string | null }

// Structural check: `./llm.js` is mocked with only `callLLM` in some suites, so
// `instanceof LLMResponseError` would throw on an undefined class.
function describeLLMResponseError(error: unknown): LLMReplyFailure | null {
  if (!(error instanceof Error) || error.name !== 'LLMResponseError') return null
  const reason = 'reason' in error && typeof error.reason === 'string' ? error.reason : null
  const finishReason = 'finishReason' in error && typeof error.finishReason === 'string' ? error.finishReason : null
  return { reason, finishReason }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function failSynthesis(error: unknown, maxTokens: number): Result<string> {
  const failure = describeLLMResponseError(error) ?? { reason: null, finishReason: null }
  logger.warn('Report synthesis reply unusable', { event: 'synthesis_reply_unusable', ...failure, maxTokens })
  return { ok: false, error: toError(error) }
}

type SynthesisCallOptions = { temperature: number; responseFormat?: LLMResponseFormat }

/**
 * One synthesis call at the base budget, retried once at the larger budget when
 * the reply was cut off by the token limit. Any other failure is returned as-is.
 */
async function callWithLengthRetry(messages: LLMMessage[], options: SynthesisCallOptions): Promise<Result<string>> {
  try {
    return { ok: true, value: await callLLM(messages, { maxTokens: SYNTHESIS_MAX_TOKENS, ...options }) }
  } catch (firstError) {
    const failure = describeLLMResponseError(firstError)
    if (failure?.reason !== 'length') return failSynthesis(firstError, SYNTHESIS_MAX_TOKENS)

    logger.warn('Report synthesis truncated; retrying with a larger token limit', {
      event: 'synthesis_reply_length_truncated',
      ...failure,
      maxTokens: SYNTHESIS_MAX_TOKENS,
      retryMaxTokens: SYNTHESIS_RETRY_MAX_TOKENS,
    })
    try {
      return { ok: true, value: await callLLM(messages, { maxTokens: SYNTHESIS_RETRY_MAX_TOKENS, ...options }) }
    } catch (retryError) {
      return failSynthesis(retryError, SYNTHESIS_RETRY_MAX_TOKENS)
    }
  }
}

function logSynthesisInput(input: SynthesisInput): void {
  logger.info('Synthesis input selected', {
    event: 'synthesis_input',
    sample: input.sample,
    painPoints: bucketCounts(input.painPoints),
    competitorWeaknesses: bucketCounts(input.competitorWeaknesses),
    emergingGaps: bucketCounts(input.emergingGaps),
  })
}

function buildSynthesisMessages(template: string, query: string, input: SynthesisInput): LLMMessage[] {
  return [{ role: 'user', content: fillTemplate(template, { query, themes: JSON.stringify(input) }) }]
}

export async function synthesizeReport(
  query: string,
  themes: ThemeBuckets & { sample?: SynthesisSample },
): Promise<Result<string>> {
  try {
    const template = loadPrompt('synthesize_report.txt')
    const input = selectSynthesisInput(themes, themes.sample)
    logSynthesisInput(input)
    const reply = await callWithLengthRetry(buildSynthesisMessages(template, query, input), { temperature: 0.2 })
    return reply.ok ? finishSynthesis(reply.value) : reply
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

const STRUCTURED_SYNTHESIS_PROMPT = 'synthesize_report_structured.txt'

type StructuredSynthesis = { summary: string; report: SynthesisReport | null }
type StructuredFallbackStage = 'prompt' | SynthesisParseError['kind']

function tryLoadPrompt(filename: string): Result<string> {
  try {
    return { ok: true, value: loadPrompt(filename) }
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

async function fallbackToProse(
  query: string,
  themes: ThemeBuckets & { sample?: SynthesisSample },
  stage: StructuredFallbackStage,
  message: string,
): Promise<Result<StructuredSynthesis>> {
  logger.warn('Structured synthesis unusable; falling back to the prose report', {
    event: 'synthesis_structured_fallback',
    stage,
    message,
  })
  const prose = await synthesizeReport(query, themes)
  return prose.ok ? { ok: true, value: { summary: prose.value, report: null } } : prose
}

/**
 * Synthesize the report as structured JSON (executive summary plus recommended
 * actions citing input theme ids). `summary` is always the five-section
 * markdown: rendered from the structured fields, or the prose report when the
 * structured prompt is missing or its reply does not parse (`report: null`).
 * LLM failures are returned as `ok:false` without a fallback call.
 */
export async function synthesizeStructuredReport(
  query: string,
  themes: ThemeBuckets & { sample?: SynthesisSample },
): Promise<Result<StructuredSynthesis>> {
  try {
    const template = tryLoadPrompt(STRUCTURED_SYNTHESIS_PROMPT)
    if (!template.ok) return await fallbackToProse(query, themes, 'prompt', template.error.message)

    const input = selectSynthesisInput(themes, themes.sample)
    logSynthesisInput(input)
    const reply = await callWithLengthRetry(buildSynthesisMessages(template.value, query, input), {
      temperature: 0.2,
      responseFormat: 'json_object',
    })
    if (!reply.ok) return reply

    const parsed = parseSynthesisReply(reply.value, input)
    if (!parsed.ok) return await fallbackToProse(query, themes, parsed.error.kind, parsed.error.message)

    const { report, droppedIds } = parsed.value
    if (droppedIds.length > 0) {
      logger.warn('Structured synthesis cited unknown theme ids; dropped them', {
        event: 'synthesis_theme_ids_dropped',
        droppedIds,
      })
    }
    logger.info('Structured synthesis complete', {
      event: 'synthesis_structured',
      replyChars: reply.value.length,
      actions: report.recommendedActions.length,
      droppedIds: droppedIds.length,
    })
    return { ok: true, value: { summary: renderReportMarkdown(report, input), report } }
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

function bucketCounts(bucket: SynthesisBucket): { kept: number; longTail: number; excludedPositive: number } {
  return { kept: bucket.themes.length, longTail: bucket.longTail.themes, excludedPositive: bucket.excludedPositive }
}

function finishSynthesis(value: string): Result<string> {
  const missingSections = findMissingSections(value)
  if (missingSections.length > 0) {
    logger.warn('Synthesized report is missing sections', {
      event: 'synthesis_incomplete',
      missingSections,
      reportLength: value.length,
    })
  }
  return { ok: true, value }
}
