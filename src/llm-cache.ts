import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { Result } from '@mira/shared-core'
import { query } from './db.js'

// ─── Key versioning ───────────────────────────────────────────────────────────

/**
 * Bump on ANY change that makes an already-cached result no longer equivalent
 * to what a fresh call would produce:
 *   - the per-item payload projection (`payloadOf` in the API call sites —
 *     `packages/api/src/services/pipeline/{categorization,extraction}.ts`;
 *     bump discipline is therefore cross-package),
 *   - the output contract (`stripFences` / enabling a JSON `response_format`),
 *   - a result Zod schema (`CategorizationResult`, `ExtractionResultSchema`).
 */
export const CACHE_KEY_VERSION = 'v1'

export type AnalysisCacheKind = 'categorize' | 'extract'

const DEFAULT_TTL_DAYS = 30

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

// ─── Model name ───────────────────────────────────────────────────────────────

/**
 * Single source of truth for the model name, shared by `callLLM` and the cache
 * key, so the key and the request can never disagree.
 */
export function resolveModelName(): string {
  return process.env.OPENAI_MODEL?.trim() || process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat'
}

// ─── Key computation ──────────────────────────────────────────────────────────

/** Prompt version = content hash of the exact template string used for the call. */
export function computeAnalysisPromptVersion(template: string): string {
  return sha256(template)
}

export interface AnalysisCacheKeyInput {
  kind: AnalysisCacheKind
  template: string
  model: string
  payload: unknown
}

/**
 * Hashes a fixed-order array (never `Object.keys`/iteration) so field order can
 * never drift, and an array rather than a `:`-joined string so the
 * variable-length `kind`/`model` fields cannot alias each other.
 */
export function computeAnalysisCacheKey(input: AnalysisCacheKeyInput): string {
  const promptVersion = computeAnalysisPromptVersion(input.template)
  const canonical = JSON.stringify([
    CACHE_KEY_VERSION,
    input.kind,
    promptVersion,
    input.model,
    JSON.stringify(input.payload),
  ])
  return sha256(canonical)
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export interface AnalysisCacheReadResult<T> {
  hits: Map<string, T>
  error?: Error
}

interface AnalysisCacheRowShape {
  cache_key: string
  result: unknown
}

/**
 * Rows whose stored `result` fails the caller's schema are omitted — a poisoned
 * row is a miss, and the subsequent write overwrites it. A failed query returns
 * an empty map plus `error`, so a broken cache is distinguishable from a cold one.
 */
export async function readAnalysisCache<T>(
  keys: string[],
  schema: z.ZodType<T>,
): Promise<AnalysisCacheReadResult<T>> {
  const hits = new Map<string, T>()
  if (!keys.length) return { hits }

  const res = await query<AnalysisCacheRowShape>(
    'SELECT cache_key, result FROM llm_analysis_cache WHERE cache_key = ANY($1) AND expires_at > now()',
    [keys],
  )
  if (!res.ok) return { hits, error: res.error }

  for (const row of res.value) {
    const parsed = schema.safeParse(row.result)
    if (parsed.success) hits.set(row.cache_key, parsed.data)
  }
  return { hits }
}

// ─── Write ────────────────────────────────────────────────────────────────────

export interface AnalysisCacheWriteRow {
  cacheKey: string
  kind: AnalysisCacheKind
  promptVersion: string
  model: string
  result: unknown
}

/**
 * Whole days only: the TTL is bound to an `::int` parameter, so a fractional
 * value would round — `0.5` would round to 0 and write rows that are already
 * expired, a permanent-miss cache in which both the read and the write succeed.
 */
function resolveTtlDays(ttlDays?: number): number {
  if (typeof ttlDays === 'number' && Number.isInteger(ttlDays) && ttlDays >= 1) return ttlDays
  const raw = process.env.MIRA_LLM_CACHE_TTL_DAYS?.trim()
  if (!raw) return DEFAULT_TTL_DAYS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_TTL_DAYS
  return parsed
}

/**
 * Deduped by `cacheKey` (last write wins) before the statement is built: two
 * items with an identical payload produce the same key, and a single
 * `INSERT … VALUES (a),(a) … ON CONFLICT DO UPDATE` raises Postgres 21000.
 */
export async function writeAnalysisCache(
  rows: AnalysisCacheWriteRow[],
  ttlDays?: number,
): Promise<Result<void>> {
  if (!rows.length) return { ok: true, value: undefined }

  const deduped = new Map<string, AnalysisCacheWriteRow>()
  for (const row of rows) deduped.set(row.cacheKey, row)
  const unique = [...deduped.values()]

  const params: unknown[] = []
  const tuples = unique.map((row) => {
    const base = params.length
    params.push(row.cacheKey, row.kind, row.promptVersion, row.model, JSON.stringify(row.result))
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, now() + ($${unique.length * 5 + 1}::int * INTERVAL '1 day'))`
  })
  params.push(resolveTtlDays(ttlDays))

  const res = await query<AnalysisCacheRowShape>(
    `INSERT INTO llm_analysis_cache (cache_key, kind, prompt_version, model, result, expires_at)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (cache_key) DO UPDATE SET result = EXCLUDED.result, expires_at = EXCLUDED.expires_at`,
    params,
  )
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, value: undefined }
}
