// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CoreSource, type CollectedItem, type ExtractionResult, type PainPointTheme } from '@mira/shared-core'

const { mockCallLLM } = vi.hoisted(() => ({ mockCallLLM: vi.fn() }))

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({ on: vi.fn(), quit: vi.fn() })),
  Redis: vi.fn().mockImplementation(() => ({ on: vi.fn(), quit: vi.fn() })),
}))

vi.mock('./llm.js', () => ({
  callLLM: mockCallLLM,
}))

vi.mock('node:fs', () => ({ readFileSync: vi.fn().mockReturnValue('{{content}} {{source}}') }))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { extractItem, aggregateThemes, synthesizeReport } from './analysis.js'

const callLLM = mockCallLLM

const mockItem: CollectedItem = {
  source: CoreSource.reddit,
  url: 'https://reddit.com/r/saas/comments/xyz',
  title: 'My invoicing tool keeps crashing',
  body: 'Every time I try to send an invoice it just crashes.',
  author: 'testuser',
  timestamp: '2024-01-01T00:00:00Z',
  engagement: { upvotes: 10, comments: 3 },
  raw_replies: ['Same here, it is unusable'],
  subreddit: 'saas',
}

const validExtraction = {
  pain_points: ['invoicing tool crashes on send'],
  sentiment: -0.8,
  category: 'complaint',
  mentioned_tools: [],
  key_quote: 'Every time I try to send an invoice it just crashes.',
}

const validExtractionJson = JSON.stringify([validExtraction])

const mockExtraction: ExtractionResult = {
  pain_points: ['invoicing tool crashes on send'],
  sentiment: -0.8,
  category: 'complaint',
  mentioned_tools: [],
  key_quote: 'Every time I try to send an invoice it just crashes.',
}

function mockJinaResponse(count: number) {
  const data = Array.from({ length: count }, (_, i) => ({
    index: i,
    embedding: [0.1, 0.2, 0.3, 0.4],
  }))
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data }), { status: 200 }))
}

describe('extractItem', () => {
  beforeEach(() => {
    vi.mocked(callLLM).mockResolvedValue(validExtractionJson)
    fetchMock.mockReset()
  })

  it('returns ok: true with ExtractionResult on valid LLM response', async () => {
    const result = await extractItem(mockItem)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sentiment).toBeCloseTo(-0.8)
    expect(result.value.category).toBe('complaint')
    expect(result.value.pain_points).toHaveLength(1)
    expect(result.value.key_quote).toBeTruthy()
  })

  it('strips markdown fences from LLM response', async () => {
    vi.mocked(callLLM).mockResolvedValue('```json\n' + JSON.stringify([validExtraction]) + '\n```')
    const result = await extractItem(mockItem)
    expect(result.ok).toBe(true)
  })

  it('returns ok: false when callLLM throws', async () => {
    vi.mocked(callLLM).mockRejectedValue(new Error('LLM timeout'))
    const result = await extractItem(mockItem)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('LLM timeout')
  })

  it('returns ok: false when LLM returns malformed JSON', async () => {
    vi.mocked(callLLM).mockResolvedValue('not json at all')
    const result = await extractItem(mockItem)
    expect(result.ok).toBe(false)
  })

  it('returns ok: false when Zod schema validation fails', async () => {
    vi.mocked(callLLM).mockResolvedValue(
      JSON.stringify([{ pain_points: [], sentiment: 'positive', category: 'complaint', mentioned_tools: [] }]),
    )
    const result = await extractItem(mockItem)
    expect(result.ok).toBe(false)
  })
})

describe('aggregateThemes', () => {
  const pair = { item: mockItem, extraction: mockExtraction }
  const savedKey = process.env.JINA_API_KEY

  beforeEach(() => {
    fetchMock.mockReset()
    process.env.JINA_API_KEY = 'test-key'
  })

  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env.JINA_API_KEY
    } else {
      process.env.JINA_API_KEY = savedKey
    }
  })

  it('returns ok: true with empty array when pairs is empty', async () => {
    const result = await aggregateThemes([])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([])
  })

  it('returns ok: true with one theme for one input pair', async () => {
    mockJinaResponse(1)
    const result = await aggregateThemes([pair])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0].frequency).toBe(1)
    expect(result.value[0].sources).toContain('reddit')
  })

  it('returns ok: false when JINA_API_KEY is missing', async () => {
    delete process.env.JINA_API_KEY
    const result = await aggregateThemes([pair])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('JINA_API_KEY')
  })

  it('returns ok: false when Jina fetch returns non-OK status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('error', { status: 503 }))
    const result = await aggregateThemes([pair])
    expect(result.ok).toBe(false)
  })

  describe('skipEmbeddings: true', () => {
    it('returns ok: true with empty array when pairs is empty', async () => {
      const result = await aggregateThemes([], { skipEmbeddings: true })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual([])
    })

    it('never calls fetch when skipEmbeddings is true with one pair', async () => {
      const result = await aggregateThemes([pair], { skipEmbeddings: true })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(1)
      expect(result.value[0].frequency).toBe(1)
      expect(result.value[0].theme).toBe(mockExtraction.key_quote)
      expect(result.value[0].sources).toContain('reddit')
    })

    it('never calls fetch when skipEmbeddings is true even without JINA_API_KEY', async () => {
      delete process.env.JINA_API_KEY
      const result = await aggregateThemes([pair], { skipEmbeddings: true })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.ok).toBe(true)
    })

    it('merges two pairs with identical key_quote into one cluster with frequency 2', async () => {
      const pair2 = {
        item: { ...mockItem, source: CoreSource.hackernews },
        extraction: { ...mockExtraction },
      }
      const result = await aggregateThemes([pair, pair2], { skipEmbeddings: true })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(1)
      expect(result.value[0].frequency).toBe(2)
      expect(result.value[0].sources).toContain('reddit')
      expect(result.value[0].sources).toContain('hackernews')
    })

    it('produces two separate themes for pairs with different key_quotes', async () => {
      const differentExtraction: ExtractionResult = {
        ...mockExtraction,
        key_quote: 'billing page is completely broken',
      }
      const pair2 = { item: mockItem, extraction: differentExtraction }
      const result = await aggregateThemes([pair, pair2], { skipEmbeddings: true })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(2)
      const themes = result.value.map((t: PainPointTheme) => t.theme)
      expect(themes).toContain(mockExtraction.key_quote)
      expect(themes).toContain(differentExtraction.key_quote)
    })

    it('sorts themes by frequency descending', async () => {
      const sameExtraction: ExtractionResult = { ...mockExtraction }
      const differentExtraction: ExtractionResult = {
        ...mockExtraction,
        key_quote: 'billing page is completely broken',
      }
      const pairs = [
        { item: mockItem, extraction: sameExtraction },
        { item: { ...mockItem, source: CoreSource.hackernews }, extraction: sameExtraction },
        { item: mockItem, extraction: differentExtraction },
      ]
      const result = await aggregateThemes(pairs, { skipEmbeddings: true })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value[0].frequency).toBeGreaterThanOrEqual(result.value[1].frequency)
    })

    it('evidence list is capped at 3 items per cluster', async () => {
      const sameExtraction: ExtractionResult = { ...mockExtraction }
      const manyPairs = Array.from({ length: 5 }, (_, i) => ({
        item: { ...mockItem, url: `https://example.com/${i}` },
        extraction: sameExtraction,
      }))
      const result = await aggregateThemes(manyPairs, { skipEmbeddings: true })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value[0].evidence.length).toBeLessThanOrEqual(3)
    })
  })

  describe('skipEmbeddings: false (explicit)', () => {
    it('still calls Jina fetch when skipEmbeddings is explicitly false', async () => {
      mockJinaResponse(1)
      const result = await aggregateThemes([pair], { skipEmbeddings: false })
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.jina.ai/v1/embeddings',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(result.ok).toBe(true)
    })
  })
})

describe('synthesizeReport', () => {
  beforeEach(() => {
    vi.mocked(callLLM).mockResolvedValue('A concise market summary.')
  })

  it('returns ok: true with the LLM response string', async () => {
    const result = await synthesizeReport('invoice pain', {
      painPoints: [],
      competitorWeaknesses: [],
      emergingGaps: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe('A concise market summary.')
  })

  it('returns ok: false when callLLM rejects', async () => {
    vi.mocked(callLLM).mockRejectedValue(new Error('rate limited'))
    const result = await synthesizeReport('test', {
      painPoints: [],
      competitorWeaknesses: [],
      emergingGaps: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('rate limited')
  })
})
