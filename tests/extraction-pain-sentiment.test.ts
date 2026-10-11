import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/llm.js', () => ({ callLLM: vi.fn() }))

import { callLLM } from '../src/llm.js'
import { ExtractionResultSchema, extractBatch, aggregateThemes } from '../src/analysis.js'

vi.stubGlobal('fetch', vi.fn())

type Category =
  | 'complaint'
  | 'feature-request'
  | 'workflow-friction'
  | 'pricing'
  | 'switching-signal'
  | 'integration-issue'
  | 'comparison'
  | 'workaround'
  | 'information-seeking'

type ExtractionResult = {
  pain_points: string[]
  sentiment: number
  pain_sentiment?: number | null
  category: Category
  mentioned_tools: string[]
  key_quote: string
}

const makeItem = (id: number) => ({
  source: 'hackernews' as const,
  url: `https://news.ycombinator.com/item?id=${id}`,
  title: `Item ${id}`,
  body: `Body of item ${id}`,
  author: 'user',
  timestamp: '2024-01-01T00:00:00Z',
  engagement: { upvotes: 1, comments: 0 },
  raw_replies: [],
})

const makeExtraction = (overrides: Partial<ExtractionResult> = {}): ExtractionResult => ({
  pain_points: ['usage cap disrupts my workflow'],
  sentiment: 0.5,
  category: 'complaint',
  mentioned_tools: [],
  key_quote: 'same quote for every pair',
  ...overrides,
})

const validReply = (overrides: Record<string, unknown> = {}) => ({
  pain_points: ['usage cap'],
  sentiment: 0.5,
  category: 'complaint',
  mentioned_tools: [],
  key_quote: 'q',
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(callLLM).mockResolvedValue('Usage cap frustration')
})

describe('ExtractionResultSchema pain_sentiment', () => {
  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] rejects pain_sentiment above 1', () => {
    const result = ExtractionResultSchema.safeParse(validReply({ pain_sentiment: 1.5 }))

    expect(result.success).toBe(false)
  })

  it('[unhappy] rejects a string label for pain_sentiment', () => {
    const result = ExtractionResultSchema.safeParse(validReply({ pain_sentiment: 'negative' }))

    expect(result.success).toBe(false)
  })

  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] parses an object without pain_sentiment (expect: green)', () => {
    const result = ExtractionResultSchema.safeParse(validReply())

    expect(result.success).toBe(true)
  })

  it('[happy] parses pain_sentiment null with empty pain_points and keeps the null', () => {
    const result = ExtractionResultSchema.safeParse(validReply({ pain_points: [], pain_sentiment: null }))

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.pain_sentiment).toBeNull()
    }
  })
})

describe('aggregateThemes pain_sentiment', () => {
  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] uses item sentiment when no pair carries pain_sentiment (expect: green)', async () => {
    const pairs = [
      { item: makeItem(1), extraction: makeExtraction({ sentiment: 0.6 }) },
      { item: makeItem(2), extraction: makeExtraction({ sentiment: 0.4 }) },
    ]

    const result = await aggregateThemes(pairs, { skipEmbeddings: true })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toHaveLength(1)
      expect(result.value[0].sentiment).toBeCloseTo(0.5, 5)
    }
  })

  it('[unhappy] falls back to item sentiment when pain_sentiment is null (expect: green)', async () => {
    const pairs = [
      { item: makeItem(1), extraction: makeExtraction({ sentiment: 0.8, pain_sentiment: null }) },
      { item: makeItem(2), extraction: makeExtraction({ sentiment: 0.8, pain_sentiment: null }) },
    ]

    const result = await aggregateThemes(pairs, { skipEmbeddings: true })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toHaveLength(1)
      expect(result.value[0].sentiment).toBeCloseTo(0.8, 5)
    }
  })

  it('[unhappy] clamps an unvalidated out-of-range pain_sentiment to -1', async () => {
    const pairs = [
      { item: makeItem(1), extraction: makeExtraction({ sentiment: 0.5, pain_sentiment: -3 }) },
      { item: makeItem(2), extraction: makeExtraction({ sentiment: 0.5, pain_sentiment: -3 }) },
    ]

    const result = await aggregateThemes(pairs, { skipEmbeddings: true })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toHaveLength(1)
      expect(result.value[0].sentiment).toBeCloseTo(-1, 5)
    }
  })

  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] averages pain_sentiment instead of item sentiment', async () => {
    const pairs = [
      { item: makeItem(1), extraction: makeExtraction({ sentiment: 0.6, pain_sentiment: -0.5 }) },
      { item: makeItem(2), extraction: makeExtraction({ sentiment: 0.4, pain_sentiment: -0.7 }) },
    ]

    const result = await aggregateThemes(pairs, { skipEmbeddings: true })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toHaveLength(1)
      expect(result.value[0].sentiment).toBeCloseTo(-0.6, 5)
    }
  })
})

describe('extractBatch pain_sentiment', () => {
  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] marks the item ok:false when the reply carries pain_sentiment 2', async () => {
    vi.mocked(callLLM).mockResolvedValue(JSON.stringify([validReply({ pain_sentiment: 2 })]))

    const results = await extractBatch([makeItem(1)])

    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(false)
  })

  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] passes pain_sentiment through instead of stripping it', async () => {
    vi.mocked(callLLM).mockResolvedValue(JSON.stringify([validReply({ pain_sentiment: -0.4 })]))

    const results = await extractBatch([makeItem(1)])

    expect(results).toHaveLength(1)
    const first = results[0]
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.value.pain_sentiment).toBe(-0.4)
    }
  })
})
