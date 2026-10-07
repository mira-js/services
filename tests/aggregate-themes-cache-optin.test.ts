import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CollectedItem, ExtractionResult } from '@mira/shared-core'

const { mockQuery, mockCallLLM } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCallLLM: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  query: mockQuery,
  closePool: vi.fn(),
}))

vi.mock('../src/llm.js', () => ({
  callLLM: mockCallLLM,
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

type Pair = { item: CollectedItem; extraction: ExtractionResult }

function makePair(n: number): Pair {
  return {
    item: {
      source: 'reddit',
      url: `https://example.com/${n}`,
      title: `t${n}`,
      body: 'b',
      author: 'a',
      timestamp: '2026-01-01T00:00:00.000Z',
      engagement: { upvotes: 1, comments: 0 },
      raw_replies: [],
    },
    extraction: {
      pain_points: [`pain ${n}`],
      sentiment: -0.4,
      category: 'complaint',
      mentioned_tools: [],
      key_quote: `quote ${n}`,
    },
  }
}

const isSelect = (sql: unknown): boolean => String(sql).trimStart().toUpperCase().startsWith('SELECT')

beforeEach(() => {
  vi.clearAllMocks()
  process.env.JINA_API_KEY = 'jina-test-key'
  process.env.LLM_MODEL = 'test-model'
  fetchMock.mockImplementation(async (_url: unknown, init: { body: string }) => {
    const body: { input: string[] } = JSON.parse(init.body)
    return new Response(
      JSON.stringify({ data: body.input.map((_t, index) => ({ index, embedding: [1, 0] })) }),
      { status: 200 },
    )
  })
  mockCallLLM.mockResolvedValue('Fresh Label')
  mockQuery.mockResolvedValue({ ok: true, value: [] })
})

afterEach(() => {
  delete process.env.JINA_API_KEY
  delete process.env.LLM_MODEL
})

describe('aggregateThemes cache opt-in', () => {
  it('[happy] without the cache option the db query is never called (expect: green)', async () => {
    const { aggregateThemes } = await import('../src/analysis.js')

    const result = await aggregateThemes([makePair(1), makePair(2)])

    expect(result.ok).toBe(true)
    expect(mockQuery).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockCallLLM).toHaveBeenCalled()
  })

  it('[happy] with cache {} and every embedding and label key hitting, no fetch or callLLM happens and themes carry the cached labels', async () => {
    const { aggregateThemes } = await import('../src/analysis.js')
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (!isSelect(sql)) return { ok: true, value: [] }
      const keys = params[0] as string[]
      if (String(sql).includes('embedding_cache')) {
        return { ok: true, value: keys.map((k) => ({ cache_key: k, embedding: [1, 0] })) }
      }
      return { ok: true, value: keys.map((k) => ({ cache_key: k, result: 'Cached Label' })) }
    })

    const result = await aggregateThemes([makePair(1), makePair(2)], { cache: {} })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockCallLLM).not.toHaveBeenCalled()
    expect(result.value.length).toBeGreaterThan(0)
    for (const theme of result.value) {
      expect(theme.synthesized_name).toBe('Cached Label')
    }
  })
})
