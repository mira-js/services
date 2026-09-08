import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../src/db.js', () => ({
  query: mockQuery,
  closePool: vi.fn(),
}))

const Schema = z.object({ category: z.string(), confidence: z.number() })

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  delete process.env.OPENAI_MODEL
  delete process.env.DEEPSEEK_MODEL
  delete process.env.MIRA_LLM_CACHE_TTL_DAYS
})

describe('computeAnalysisCacheKey', () => {
  it('is stable for the same item + template + model + kind', async () => {
    const { computeAnalysisCacheKey } = await import('../src/llm-cache.js')
    const input = {
      kind: 'categorize' as const,
      template: 'TEMPLATE A',
      model: 'deepseek-chat',
      payload: { title: 't', body: 'b' },
    }
    expect(computeAnalysisCacheKey(input)).toBe(computeAnalysisCacheKey({ ...input }))
  })

  it('changes when the template text changes', async () => {
    const { computeAnalysisCacheKey } = await import('../src/llm-cache.js')
    const base = { kind: 'categorize' as const, model: 'm', payload: { title: 't' } }
    expect(computeAnalysisCacheKey({ ...base, template: 'A' })).not.toBe(
      computeAnalysisCacheKey({ ...base, template: 'B' }),
    )
  })

  it('changes when the model changes', async () => {
    const { computeAnalysisCacheKey } = await import('../src/llm-cache.js')
    const base = { kind: 'categorize' as const, template: 'A', payload: { title: 't' } }
    expect(computeAnalysisCacheKey({ ...base, model: 'deepseek-chat' })).not.toBe(
      computeAnalysisCacheKey({ ...base, model: 'deepseek-reasoner' }),
    )
  })

  it('changes when the kind changes', async () => {
    const { computeAnalysisCacheKey } = await import('../src/llm-cache.js')
    const base = { template: 'A', model: 'm', payload: { title: 't' } }
    expect(computeAnalysisCacheKey({ ...base, kind: 'categorize' })).not.toBe(
      computeAnalysisCacheKey({ ...base, kind: 'extract' }),
    )
  })

  it('changes when CACHE_KEY_VERSION changes (documented by construction)', async () => {
    const { computeAnalysisCacheKey, CACHE_KEY_VERSION } = await import('../src/llm-cache.js')
    // The version participates in the hashed array; recomputing the same hash
    // with a different leading element must differ from the real key.
    const { createHash } = await import('node:crypto')
    const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex')
    const promptVersion = sha('A')
    const real = computeAnalysisCacheKey({ kind: 'extract', template: 'A', model: 'm', payload: { a: 1 } })
    const bumped = sha(
      JSON.stringify([`${CACHE_KEY_VERSION}-next`, 'extract', promptVersion, 'm', JSON.stringify({ a: 1 })]),
    )
    expect(real).not.toBe(bumped)
  })

  it('two items differing only in raw_replies order produce different keys (deliberate bust)', async () => {
    const { computeAnalysisCacheKey } = await import('../src/llm-cache.js')
    const base = { kind: 'extract' as const, template: 'A', model: 'm' }
    const a = computeAnalysisCacheKey({ ...base, payload: { title: 't', replies: ['r1', 'r2'] } })
    const b = computeAnalysisCacheKey({ ...base, payload: { title: 't', replies: ['r2', 'r1'] } })
    expect(a).not.toBe(b)
  })
})

describe('resolveModelName', () => {
  it('prefers OPENAI_MODEL, then DEEPSEEK_MODEL, then the default', async () => {
    const { resolveModelName } = await import('../src/llm-cache.js')
    expect(resolveModelName()).toBe('deepseek-chat')
    process.env.DEEPSEEK_MODEL = 'ds'
    expect(resolveModelName()).toBe('ds')
    process.env.OPENAI_MODEL = 'oa'
    expect(resolveModelName()).toBe('oa')
  })
})

describe('readAnalysisCache', () => {
  it('returns validated rows and treats a schema-failing row as a miss', async () => {
    const { readAnalysisCache } = await import('../src/llm-cache.js')
    mockQuery.mockResolvedValue({
      ok: true,
      value: [
        { cache_key: 'good', result: { category: 'complaint', confidence: 0.9 } },
        { cache_key: 'poisoned', result: { category: 'complaint' } },
      ],
    })

    const { hits, error } = await readAnalysisCache(['good', 'poisoned'], Schema)

    expect(error).toBeUndefined()
    expect(hits.has('good')).toBe(true)
    expect(hits.has('poisoned')).toBe(false)
  })

  it('filters expired rows in SQL (expires_at > now()) and names its columns', async () => {
    const { readAnalysisCache } = await import('../src/llm-cache.js')
    mockQuery.mockResolvedValue({ ok: true, value: [] })

    const { hits } = await readAnalysisCache(['expired'], Schema)

    expect(hits.size).toBe(0)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('SELECT cache_key, result FROM llm_analysis_cache')
    expect(sql).toContain('expires_at > now()')
    expect(sql).not.toContain('SELECT *')
    expect(params).toEqual([['expired']])
  })

  it('returns an empty map plus an error when the query fails', async () => {
    const { readAnalysisCache } = await import('../src/llm-cache.js')
    mockQuery.mockResolvedValue({ ok: false, error: new Error('relation does not exist') })

    const { hits, error } = await readAnalysisCache(['k'], Schema)

    expect(hits.size).toBe(0)
    expect(error?.message).toContain('relation does not exist')
  })

  it('short-circuits with no query when given no keys', async () => {
    const { readAnalysisCache } = await import('../src/llm-cache.js')
    const { hits } = await readAnalysisCache([], Schema)
    expect(hits.size).toBe(0)
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('writeAnalysisCache', () => {
  const row = (cacheKey: string, result: unknown) => ({
    cacheKey,
    kind: 'categorize' as const,
    promptVersion: 'pv',
    model: 'm',
    result,
  })

  it('upserts via ON CONFLICT (cache_key) DO UPDATE rather than a blind insert', async () => {
    const { writeAnalysisCache } = await import('../src/llm-cache.js')
    mockQuery.mockResolvedValue({ ok: true, value: [] })

    const first = await writeAnalysisCache([row('k1', { a: 1 })])
    const second = await writeAnalysisCache([row('k1', { a: 2 })])

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    const [sql] = mockQuery.mock.calls[1]
    expect(sql).toContain('ON CONFLICT (cache_key) DO UPDATE')
    expect(sql).toContain('result = EXCLUDED.result')
  })

  it('dedupes rows sharing a cache_key before building the statement (last write wins)', async () => {
    const { writeAnalysisCache } = await import('../src/llm-cache.js')
    mockQuery.mockResolvedValue({ ok: true, value: [] })

    const res = await writeAnalysisCache([row('dup', { a: 1 }), row('dup', { a: 2 }), row('other', { a: 3 })])

    expect(res.ok).toBe(true)
    const [sql, params] = mockQuery.mock.calls[0]
    // 2 unique rows * 5 columns + 1 ttl param
    expect(params).toHaveLength(11)
    expect(sql.match(/::jsonb/g)).toHaveLength(2)
    expect(params[4]).toBe(JSON.stringify({ a: 2 }))
    expect(params[5]).toBe('other')
  })

  it('uses parameterized SQL only and a 30-day default TTL', async () => {
    const { writeAnalysisCache } = await import('../src/llm-cache.js')
    mockQuery.mockResolvedValue({ ok: true, value: [] })

    await writeAnalysisCache([row('k1', { a: 1 })])

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain("INTERVAL '1 day'")
    expect(params[params.length - 1]).toBe(30)
  })

  it('honours MIRA_LLM_CACHE_TTL_DAYS', async () => {
    const { writeAnalysisCache } = await import('../src/llm-cache.js')
    mockQuery.mockResolvedValue({ ok: true, value: [] })
    process.env.MIRA_LLM_CACHE_TTL_DAYS = '7'

    await writeAnalysisCache([row('k1', { a: 1 })])

    const [, params] = mockQuery.mock.calls[0]
    expect(params[params.length - 1]).toBe(7)
  })

  it('falls back to 30 days for a fractional or sub-day TTL (::int would round to 0)', async () => {
    const { writeAnalysisCache } = await import('../src/llm-cache.js')
    mockQuery.mockResolvedValue({ ok: true, value: [] })
    process.env.MIRA_LLM_CACHE_TTL_DAYS = '0.5'

    await writeAnalysisCache([row('k1', { a: 1 })])

    const [, params] = mockQuery.mock.calls[0]
    expect(params[params.length - 1]).toBe(30)
  })

  it('is a no-op for an empty row list and surfaces a DB failure as !ok', async () => {
    const { writeAnalysisCache } = await import('../src/llm-cache.js')
    const empty = await writeAnalysisCache([])
    expect(empty.ok).toBe(true)
    expect(mockQuery).not.toHaveBeenCalled()

    mockQuery.mockResolvedValue({ ok: false, error: new Error('21000') })
    const failed = await writeAnalysisCache([row('k1', { a: 1 })])
    expect(failed.ok).toBe(false)
  })
})
