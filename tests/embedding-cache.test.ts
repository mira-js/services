import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../src/db.js', () => ({
  query: mockQuery,
  closePool: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  delete process.env.MIRA_LLM_CACHE_TTL_DAYS
})

describe('readEmbeddingCache', () => {
  it('[unhappy] returns an empty hits map and the error when the query is ok:false', async () => {
    const { readEmbeddingCache } = await import('../src/embedding-cache.js')
    const failure = new Error('connection refused')
    mockQuery.mockResolvedValue({ ok: false, error: failure })

    const result = await readEmbeddingCache(['k1', 'k2'])

    expect(result.hits).toBeInstanceOf(Map)
    expect(result.hits.size).toBe(0)
    expect(result.error).toBe(failure)
  })
})

describe('computeEmbeddingCacheKey', () => {
  it('[happy] is stable for equal input and changes when model, task, dimensions or text changes', async () => {
    const { computeEmbeddingCacheKey, EMBEDDING_CACHE_VERSION } = await import('../src/embedding-cache.js')
    const base = { model: 'jina-embeddings-v4', task: 'text-matching', dimensions: null, text: 'hello world' }

    const key = computeEmbeddingCacheKey(base)
    expect(computeEmbeddingCacheKey({ ...base })).toBe(key)

    const expected = createHash('sha256')
      .update(
        JSON.stringify([EMBEDDING_CACHE_VERSION, base.model, base.task, base.dimensions, base.text]),
        'utf8',
      )
      .digest('hex')
    expect(key).toBe(expected)

    expect(computeEmbeddingCacheKey({ ...base, model: 'other-model' })).not.toBe(key)
    expect(computeEmbeddingCacheKey({ ...base, task: 'retrieval.query' })).not.toBe(key)
    expect(computeEmbeddingCacheKey({ ...base, dimensions: 512 })).not.toBe(key)
    expect(computeEmbeddingCacheKey({ ...base, text: 'hello there' })).not.toBe(key)
  })
})

describe('writeEmbeddingCache', () => {
  it('[happy] dedupes duplicate keys, binds embeddings as $n::float8[] and the TTL through resolveCacheTtlDays', async () => {
    const { writeEmbeddingCache } = await import('../src/embedding-cache.js')
    process.env.MIRA_LLM_CACHE_TTL_DAYS = '7'
    mockQuery.mockResolvedValue({ ok: true, value: [] })

    const base = { model: 'jina-embeddings-v4', task: 'text-matching', dimensions: null }
    const result = await writeEmbeddingCache([
      { ...base, cacheKey: 'dup', embedding: [0.1, 0.2] },
      { ...base, cacheKey: 'other', embedding: [0.3, 0.4] },
      { ...base, cacheKey: 'dup', embedding: [0.5, 0.6] },
    ])

    expect(result.ok).toBe(true)
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]

    expect(sql).toContain('embedding_cache')
    expect(sql).toContain('ON CONFLICT (cache_key)')
    // Two unique keys, so exactly two embedding tuples.
    expect(sql.match(/::float8\[\]/g)).toHaveLength(2)
    expect(sql).toMatch(/\$\d+::int \* INTERVAL '1 day'/)

    expect(params.filter((p) => p === 'dup')).toHaveLength(1)
    expect(params).toContain('other')
    // Last write wins for the duplicate key.
    expect(params.some((p) => Array.isArray(p) && p[0] === 0.5 && p[1] === 0.6)).toBe(true)
    expect(params.some((p) => Array.isArray(p) && p[0] === 0.1)).toBe(false)
    expect(params.some((p) => Array.isArray(p) && p[0] === 0.3 && p[1] === 0.4)).toBe(true)
    // TTL comes from resolveCacheTtlDays (env override here).
    expect(params).toContain(7)
  })
})
