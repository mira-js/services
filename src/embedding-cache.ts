// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Result } from '@mira/shared-core'
import { query } from './db.js'
import { resolveCacheTtlDays } from './llm-cache.js'

// ─── Key versioning ───────────────────────────────────────────────────────────

export const JINA_EMBEDDING_MODEL = 'jina-embeddings-v4'
export const JINA_EMBEDDING_TASK = 'text-matching'

/**
 * Bump when the stored vector for an unchanged (model, task, dimensions, text)
 * could differ, for example a change to how the embedded text is normalised.
 * A model, task or dimensions change needs no bump: each is a key element.
 */
export const EMBEDDING_CACHE_VERSION = 'v1'

export interface EmbeddingCacheKeyInput {
  model: string
  task: string
  /** Requested output dimensions; `null` while the provider default is used. */
  dimensions: number | null
  text: string
}

/** sha256 of a fixed-order array, so variable-length fields cannot alias. */
export function computeEmbeddingCacheKey(input: EmbeddingCacheKeyInput): string {
  const canonical = JSON.stringify([
    EMBEDDING_CACHE_VERSION,
    input.model,
    input.task,
    input.dimensions,
    input.text,
  ])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

// ─── Read ─────────────────────────────────────────────────────────────────────

const EmbeddingSchema = z.array(z.number().finite()).min(1)

interface EmbeddingCacheRowShape {
  cache_key: string
  embedding: unknown
}

export interface EmbeddingCacheReadResult {
  hits: Map<string, number[]>
  error?: Error
}

/**
 * A row whose vector fails validation (empty, non-numeric) is omitted and so
 * becomes a miss that the subsequent write overwrites. A failed query returns
 * an empty map plus `error`; it never throws.
 */
export async function readEmbeddingCache(keys: string[]): Promise<EmbeddingCacheReadResult> {
  const hits = new Map<string, number[]>()
  if (!keys.length) return { hits }

  const res = await query<EmbeddingCacheRowShape>(
    'SELECT cache_key, embedding FROM embedding_cache WHERE cache_key = ANY($1) AND expires_at > now()',
    [keys],
  )
  if (!res.ok) return { hits, error: res.error }

  for (const row of res.value) {
    const parsed = EmbeddingSchema.safeParse(row.embedding)
    if (parsed.success) hits.set(row.cache_key, parsed.data)
  }
  return { hits }
}

// ─── Write ────────────────────────────────────────────────────────────────────

export interface EmbeddingCacheWriteRow {
  cacheKey: string
  model: string
  task: string
  dimensions: number | null
  embedding: number[]
}

/**
 * Mirrors `writeAnalysisCache`: deduped by `cacheKey` (last write wins) so one
 * statement never upserts the same key twice (Postgres 21000). Each vector is
 * bound as a JS array parameter cast to `float8[]`, never interpolated.
 */
export async function writeEmbeddingCache(
  rows: EmbeddingCacheWriteRow[],
  ttlDays?: number,
): Promise<Result<void>> {
  if (!rows.length) return { ok: true, value: undefined }

  const deduped = new Map<string, EmbeddingCacheWriteRow>()
  for (const row of rows) deduped.set(row.cacheKey, row)
  const unique = [...deduped.values()]

  const ttlParam = unique.length * 5 + 1
  const params: unknown[] = []
  const tuples = unique.map((row) => {
    const base = params.length
    params.push(row.cacheKey, row.model, row.task, row.dimensions, row.embedding)
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::int, $${base + 5}::float8[], now() + ($${ttlParam}::int * INTERVAL '1 day'))`
  })
  params.push(resolveCacheTtlDays(ttlDays))

  const res = await query<EmbeddingCacheRowShape>(
    `INSERT INTO embedding_cache (cache_key, model, task, dimensions, embedding, expires_at)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (cache_key) DO UPDATE SET embedding = EXCLUDED.embedding, expires_at = EXCLUDED.expires_at`,
    params,
  )
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, value: undefined }
}
