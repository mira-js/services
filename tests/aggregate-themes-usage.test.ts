import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Category } from '@mira/shared-core'

// PL-4a: `aggregateThemes` gained `options.onUsage?: LLMUsageSink`, threaded
// through `synthesizeThemeLabel` to `callLLM`. Runs against `src` — proves
// source behaviour only, never `dist` freshness. Mocks the OpenAI constructor
// exactly as tests/llm-usage.test.ts so real `callLLM` runs end to end.

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('openai', () => {
  const ctor = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }))
  return { default: ctor, OpenAI: ctor }
})

// Embeddings are never reached with skipEmbeddings: true — stub fetch so a
// wrong option name fails loudly instead of hitting api.jina.ai.
vi.stubGlobal('fetch', vi.fn())

beforeEach(() => {
  vi.clearAllMocks()
  process.env.OPENAI_API_KEY = 'test-key'
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: 'Nightly Sync Failures' } }],
    usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
  })
})

type ExtractionResult = {
  pain_points: string[]
  sentiment: number
  category: Category
  mentioned_tools: string[]
  key_quote: string
}

function makePair(keyQuote: string) {
  const extraction: ExtractionResult = {
    pain_points: ['sync stalls'],
    sentiment: -0.3,
    category: 'complaint',
    mentioned_tools: [],
    key_quote: keyQuote,
  }
  const item = {
    source: 'reddit',
    url: `https://example.com/${keyQuote}`,
    title: 'title',
    body: 'body',
    author: 'author',
    timestamp: '2026-01-01T00:00:00.000Z',
    engagement: { upvotes: 1, comments: 0 },
    raw_replies: [],
  }
  return { item, extraction }
}

describe('aggregateThemes — onUsage sink', () => {
  it('forwards the sink so it receives one usage record per cluster label call', async () => {
    const { aggregateThemes } = await import('../src/analysis.js')
    const onUsage = vi.fn()
    const pairs = [makePair('quote-a'), makePair('quote-b')]

    const result = await aggregateThemes(pairs, { skipEmbeddings: true, onUsage })

    expect(result.ok).toBe(true)
    expect(onUsage).toHaveBeenCalledTimes(2)
    expect(onUsage).toHaveBeenCalledWith({
      model: expect.any(String),
      promptTokens: 6,
      completionTokens: 3,
      totalTokens: 9,
    })
  })

  it('behaves identically when the sink is omitted', async () => {
    const { aggregateThemes } = await import('../src/analysis.js')
    const pairs = [makePair('quote-a'), makePair('quote-b')]

    const withSink = await aggregateThemes(pairs, { skipEmbeddings: true, onUsage: vi.fn() })
    const withoutSink = await aggregateThemes(pairs, { skipEmbeddings: true })

    expect(withoutSink.ok).toBe(true)
    expect(withoutSink).toEqual(withSink)
  })
})
