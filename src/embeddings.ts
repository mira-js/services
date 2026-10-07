// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import type { Result } from '@mira/shared-core'
import { recordEmbeddingRequest } from '@mira/shared-core/usage-scope'
import { logger } from '@mira/shared-core/logger'
import { fetchWithRetryOn429 } from './jina-retry.js'
import {
  JINA_EMBEDDING_MODEL,
  JINA_EMBEDDING_TASK,
  computeEmbeddingCacheKey,
  readEmbeddingCache,
  writeEmbeddingCache,
} from './embedding-cache.js'
import type { EmbeddingCacheReadResult, EmbeddingCacheWriteRow } from './embedding-cache.js'
import type { ThemeCacheOptions } from './theme-labels.js'

const JinaResponseSchema = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
})

/** Jina's default output size is used; the key carries `null` until that changes (item 184). */
const EMBEDDING_DIMENSIONS: number | null = null

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
        model: JINA_EMBEDDING_MODEL,
        task: JINA_EMBEDDING_TASK,
        input: texts,
      }),
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const causeMsg = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
    throw new Error(`Jina embeddings request failed: ${msg}${causeMsg ? ` (cause: ${causeMsg})` : ''}`)
  }
}

/** One Jina request for `texts`, vectors returned in input order. Throws on failure. */
async function fetchFromJina(texts: string[]): Promise<number[][]> {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warnCacheUnavailable(reason: string): void {
  logger.warn('llm_cache_unavailable', { kind: 'embedding', reason })
}

function logCacheStats(hits: number, misses: number): void {
  if (process.env.MIRA_LOG_LLM_USAGE !== '1') return
  logger.info('llm_cache', { event: 'llm_cache', kind: 'embedding', hits, misses })
}

/** Fails open: a rejected or failed read is reported as an empty hit map. */
async function safeRead(keys: string[]): Promise<Map<string, number[]>> {
  const read: EmbeddingCacheReadResult = await readEmbeddingCache(keys).catch(
    (error: unknown): EmbeddingCacheReadResult => ({
      hits: new Map(),
      error: error instanceof Error ? error : new Error(String(error)),
    }),
  )
  if (read.error) warnCacheUnavailable(`read: ${read.error.message}`)
  return read.hits
}

/** Fails open: a write error is logged and swallowed. */
async function safeWrite(rows: EmbeddingCacheWriteRow[]): Promise<void> {
  const res: Result<void> = await writeEmbeddingCache(rows).catch(
    (error: unknown): Result<void> => ({ ok: false, error: new Error(errorMessage(error)) }),
  )
  if (!res.ok) warnCacheUnavailable(`write: ${res.error.message}`)
}

/**
 * Embeds `texts`, returning one vector per input in input order. Throws, as
 * before; `aggregateThemes` catches. Without `cache` this is a single Jina
 * request with no DB access. With `cache`, cached vectors are reused and only
 * the distinct missed texts are sent to Jina, in one request; an all-hit call
 * makes no request and needs no `JINA_API_KEY`.
 */
export async function getEmbeddings(texts: string[], cache?: ThemeCacheOptions): Promise<number[][]> {
  if (!cache) return fetchFromJina(texts)

  const keys = texts.map((text) =>
    computeEmbeddingCacheKey({
      model: JINA_EMBEDDING_MODEL,
      task: JINA_EMBEDDING_TASK,
      dimensions: EMBEDDING_DIMENSIONS,
      text,
    }),
  )
  const hits = cache.bust ? new Map<string, number[]>() : await safeRead([...new Set(keys)])

  // Distinct missed texts, keyed by cache key so duplicates are fetched once.
  const missed = new Map<string, string>()
  keys.forEach((key, i) => {
    if (!hits.has(key) && !missed.has(key)) missed.set(key, texts[i])
  })
  logCacheStats(keys.filter((k) => hits.has(k)).length, missed.size)

  if (missed.size > 0) {
    const missKeys = [...missed.keys()]
    const fetched = await fetchFromJina([...missed.values()])
    if (fetched.length !== missKeys.length) {
      throw new Error(`Jina embeddings returned ${fetched.length} vectors for ${missKeys.length} inputs`)
    }
    const rows: EmbeddingCacheWriteRow[] = missKeys.map((cacheKey, i) => ({
      cacheKey,
      model: JINA_EMBEDDING_MODEL,
      task: JINA_EMBEDDING_TASK,
      dimensions: EMBEDDING_DIMENSIONS,
      embedding: fetched[i],
    }))
    for (const row of rows) hits.set(row.cacheKey, row.embedding)
    await safeWrite(rows)
  }

  return keys.map((key) => {
    const vector = hits.get(key)
    if (!vector) throw new Error('Jina embeddings returned fewer vectors than requested')
    return vector
  })
}
