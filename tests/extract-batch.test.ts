import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CollectedItem, ExtractionResult } from '@mira/shared-core'
import { extractBatch } from '../src/analysis'

vi.mock('../src/llm.js', () => ({
  callLLM: vi.fn(),
}))

vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue('Batch extract from items: {{items}}'),
}))

const makeItem = (id: number, overrides: Partial<CollectedItem> = {}): CollectedItem => ({
  source: 'hackernews',
  url: `https://news.ycombinator.com/item?id=${id}`,
  title: `Item ${id}`,
  body: `Body of item ${id}`,
  author: 'user',
  timestamp: '2024-01-01T00:00:00Z',
  engagement: { upvotes: 1, comments: 0 },
  raw_replies: [],
  ...overrides,
})

const mockExtraction: ExtractionResult = {
  pain_points: ['slow'],
  sentiment: -0.8,
  category: 'complaint',
  mentioned_tools: [],
  key_quote: 'slow',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('extractBatch', () => {
  it('returns all success results for valid LLM array response', async () => {
    const { callLLM } = await import('../src/llm.js')
    const items = [makeItem(1), makeItem(2), makeItem(3)]
    vi.mocked(callLLM).mockResolvedValue(
      JSON.stringify([mockExtraction, mockExtraction, mockExtraction]),
    )

    const results = await extractBatch(items)

    expect(results).toHaveLength(3)
    expect(results[0].ok).toBe(true)
    expect(results[1].ok).toBe(true)
    expect(results[2].ok).toBe(true)
  })

  it('sends items as JSON array in prompt template', async () => {
    const { callLLM } = await import('../src/llm.js')
    const items = [
      makeItem(1, { title: 'Title A', body: 'Body A', raw_replies: ['reply1', 'reply2'] }),
      makeItem(2, { title: 'Title B', body: 'Body B', raw_replies: [] }),
    ]
    vi.mocked(callLLM).mockResolvedValue(
      JSON.stringify([mockExtraction, mockExtraction]),
    )

    await extractBatch(items)

    const [messages] = vi.mocked(callLLM).mock.calls[0]
    const content = messages[0].content as string
    expect(content).toContain('Title A')
    expect(content).toContain('Title B')
    expect(content).toContain('reply1')
    expect(content).toContain('hackernews')
  })

  it('returns all errors when LLM returns wrong count of results', async () => {
    const { callLLM } = await import('../src/llm.js')
    const items = [makeItem(1), makeItem(2), makeItem(3)]
    vi.mocked(callLLM).mockResolvedValue(
      JSON.stringify([mockExtraction]),
    )

    const results = await extractBatch(items)

    expect(results).toHaveLength(3)
    for (const result of results) {
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toContain('returned 1 results for 3 items')
      }
    }
  })

  it('returns all errors when LLM call fails', async () => {
    const { callLLM } = await import('../src/llm.js')
    const items = [makeItem(1), makeItem(2)]
    vi.mocked(callLLM).mockRejectedValue(new Error('network error'))

    const results = await extractBatch(items)

    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('llm-error: network error')
      }
    }
  })

  it('returns all errors tagged schema-error: when sentiment is a string label', async () => {
    const { callLLM } = await import('../src/llm.js')
    const items = [makeItem(1), makeItem(2)]
    vi.mocked(callLLM).mockResolvedValue(
      JSON.stringify([
        { ...mockExtraction, sentiment: 'negative' },
        { ...mockExtraction, sentiment: 'negative' },
      ]),
    )

    const results = await extractBatch(items)

    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toMatch(/^schema-error:/)
      }
    }
  })

  it('returns all errors when LLM returns invalid JSON', async () => {
    const { callLLM } = await import('../src/llm.js')
    const items = [makeItem(1), makeItem(2)]
    vi.mocked(callLLM).mockResolvedValue('not valid json')

    const results = await extractBatch(items)

    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.ok).toBe(false)
    }
  })

  it('handles items with different extraction categories', async () => {
    const { callLLM } = await import('../src/llm.js')
    const items = [makeItem(1), makeItem(2)]
    vi.mocked(callLLM).mockResolvedValue(
      JSON.stringify([
        { ...mockExtraction, category: 'complaint' },
        { ...mockExtraction, category: 'feature-request' },
      ]),
    )

    const results = await extractBatch(items)

    expect(results).toHaveLength(2)
    if (results[0].ok) expect(results[0].value.category).toBe('complaint')
    if (results[1].ok) expect(results[1].value.category).toBe('feature-request')
  })

  it('returns empty array for empty input', async () => {
    const results = await extractBatch([])
    expect(results).toHaveLength(0)
  })

  it('includes itemIndex in BatchError for each failed item', async () => {
    const { callLLM } = await import('../src/llm.js')
    const items = [makeItem(1), makeItem(2), makeItem(3)]
    vi.mocked(callLLM).mockResolvedValue(JSON.stringify([]))

    const results = await extractBatch(items)

    expect(results).toHaveLength(3)
    if (!results[0].ok) expect(results[0].error.itemIndex).toBe(0)
    if (!results[1].ok) expect(results[1].error.itemIndex).toBe(1)
    if (!results[2].ok) expect(results[2].error.itemIndex).toBe(2)
  })

  it('includes original item reference in BatchError', async () => {
    const { callLLM } = await import('../src/llm.js')
    const items = [makeItem(1, { title: 'First Item' }), makeItem(2, { title: 'Second Item' })]
    vi.mocked(callLLM).mockResolvedValue(JSON.stringify([]))

    const results = await extractBatch(items)

    if (!results[0].ok) {
      expect(results[0].error.item.title).toBe('First Item')
    }
    if (!results[1].ok) {
      expect(results[1].error.item.title).toBe('Second Item')
    }
  })

  it('strips markdown code fences from LLM response', async () => {
    const { callLLM } = await import('../src/llm.js')
    const items = [makeItem(1)]
    vi.mocked(callLLM).mockResolvedValue(
      '```json\n' + JSON.stringify([mockExtraction]) + '\n```',
    )

    const results = await extractBatch(items)

    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)
    if (results[0].ok) {
      expect(results[0].value.pain_points).toEqual(['slow'])
    }
  })
})