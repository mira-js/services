import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CollectedItem } from '@mira/shared-core'

vi.mock('../src/llm.js', () => ({ callLLM: vi.fn() }))

import { callLLM } from '../src/llm.js'
import { ExtractionResultSchema, extractBatch } from '../src/analysis.js'

const makeItem = (id: number): CollectedItem => ({
  source: 'hackernews',
  url: `https://news.ycombinator.com/item?id=${id}`,
  title: `Quota complaint ${id}`,
  body: `Body of item ${id}`,
  author: 'user',
  timestamp: '2024-01-01T00:00:00Z',
  engagement: { upvotes: 1, comments: 0 },
  raw_replies: [],
})

const validExtraction = {
  pain_points: ['quota runs out'],
  sentiment: -0.6,
  category: 'complaint',
  mentioned_tools: [],
  key_quote: 'quota runs out',
}

const messagesOfFirstCall = (): Array<{ role: string; content: string }> => {
  const call = vi.mocked(callLLM).mock.calls[0]
  return call[0]
}

describe('ExtractionResultSchema subject_relation', () => {
  beforeEach(() => vi.clearAllMocks())

  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] rejects an unknown subject_relation value', () => {
    expect(() => ExtractionResultSchema.parse({ ...validExtraction, subject_relation: 'maybe' })).toThrow()
  })

  it('[unhappy] parses an object without subject_relation and leaves the key absent (expect: green)', () => {
    const parsed = ExtractionResultSchema.parse(validExtraction)

    expect('subject_relation' in parsed).toBe(false)
  })
})

describe('extractBatch subject handling', () => {
  beforeEach(() => vi.clearAllMocks())

  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] fails every item with a schema-error when the reply carries an unknown subject_relation', async () => {
    vi.mocked(callLLM).mockResolvedValue(
      JSON.stringify([
        { ...validExtraction, subject_relation: 'other' },
        { ...validExtraction, subject_relation: 'subject' },
      ]),
    )

    const results = await extractBatch([makeItem(1), makeItem(2)], { subjectProducts: ['Claude Code'] })

    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message.startsWith('schema-error:')).toBe(true)
    }
  })

  it('[unhappy] sends exactly one message when subjectProducts is empty (expect: green)', async () => {
    vi.mocked(callLLM).mockResolvedValue(JSON.stringify([validExtraction]))

    await extractBatch([makeItem(1)], { subjectProducts: [] })

    expect(callLLM).toHaveBeenCalledTimes(1)
    expect(messagesOfFirstCall()).toHaveLength(1)
  })

  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] sends the subject as a second user message and keeps it out of the template message', async () => {
    vi.mocked(callLLM).mockResolvedValue(JSON.stringify([{ ...validExtraction, subject_relation: 'competitor' }]))

    const results = await extractBatch([makeItem(1)], { subjectProducts: ['Claude Code'] })

    const messages = messagesOfFirstCall()
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({
      role: 'user',
      content: JSON.stringify({ subject_products: ['Claude Code'] }),
    })
    expect(messages[0].content).not.toContain('Claude Code')
    expect(results[0].ok).toBe(true)
    if (results[0].ok) expect(results[0].value.subject_relation).toBe('competitor')
  })
})
