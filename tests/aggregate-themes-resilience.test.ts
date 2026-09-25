import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Category } from '@mira/shared-core'

vi.mock('../src/llm.js', () => ({ callLLM: vi.fn() }))
vi.stubGlobal('fetch', vi.fn())

beforeEach(() => {
  vi.clearAllMocks()
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

describe('aggregateThemes — label synthesis resilience', () => {
  it('[unhappy] a rejected callLLM for one cluster of three leaves it without synthesized_name, keeps ok:true and the others labeled', async () => {
    const { callLLM } = await import('../src/llm.js')
    vi.mocked(callLLM)
      .mockResolvedValueOnce('Label One')
      .mockRejectedValueOnce(new Error('LLM synthesis failed'))
      .mockResolvedValueOnce('Label Three')

    const { aggregateThemes } = await import('../src/analysis.js')
    const pairs = [makePair('quote-a'), makePair('quote-b'), makePair('quote-c')]

    const result = await aggregateThemes(pairs, { skipEmbeddings: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(3)
    const withoutLabel = result.value.filter((t) => !t.synthesized_name)
    const withLabel = result.value.filter((t) => t.synthesized_name)
    expect(withoutLabel).toHaveLength(1)
    expect(withLabel).toHaveLength(2)
  })

  it('[unhappy] every label callLLM rejects → ok:true, all themes present, none has synthesized_name', async () => {
    const { callLLM } = await import('../src/llm.js')
    vi.mocked(callLLM).mockRejectedValue(new Error('LLM synthesis failed'))

    const { aggregateThemes } = await import('../src/analysis.js')
    const pairs = [makePair('quote-a'), makePair('quote-b'), makePair('quote-c')]

    const result = await aggregateThemes(pairs, { skipEmbeddings: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(3)
    for (const theme of result.value) {
      expect(theme.synthesized_name).toBeUndefined()
    }
  })

  it('[unhappy] embeddings fetch throws → ok:false, error.message contains the underlying message and cause', async () => {
    process.env.JINA_API_KEY = 'test-key'
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }))

    const { aggregateThemes } = await import('../src/analysis.js')
    const pairs = [makePair('quote-a')]

    const result = await aggregateThemes(pairs, { skipEmbeddings: false })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('fetch failed')
    expect(result.error.message).toContain('ECONNRESET')
  })

  it('[unhappy] embeddings fetch returns 429 with a response body → ok:false, message contains status but never the body', async () => {
    process.env.JINA_API_KEY = 'test-key'
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ error: 'secret-body' }),
      text: async () => 'secret-body',
    } as Response)

    const { aggregateThemes } = await import('../src/analysis.js')
    const pairs = [makePair('quote-a')]

    const result = await aggregateThemes(pairs, { skipEmbeddings: false })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('429')
    expect(result.error.message).not.toContain('secret-body')
  })

  it('[happy] label synthesis runs with bounded concurrency — max in-flight <= 5, 12 themes returned', async () => {
    const { callLLM } = await import('../src/llm.js')
    let inFlight = 0
    let maxInFlight = 0
    vi.mocked(callLLM).mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return 'Label'
    })

    const { aggregateThemes } = await import('../src/analysis.js')
    const pairs = Array.from({ length: 12 }, (_, i) => makePair(`quote-${i}`))

    const result = await aggregateThemes(pairs, { skipEmbeddings: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(12)
    expect(maxInFlight).toBeLessThanOrEqual(5)
  })

  it('[happy] missing JINA_API_KEY → ok:false (existing contract kept)', async () => {
    delete process.env.JINA_API_KEY
    const { aggregateThemes } = await import('../src/analysis.js')
    const pairs = [makePair('quote-a')]

    const result = await aggregateThemes(pairs, { skipEmbeddings: false })

    expect(result.ok).toBe(false)
  })

  it('[happy] Jina 503 → ok:false (existing contract kept)', async () => {
    process.env.JINA_API_KEY = 'test-key'
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
      text: async () => '',
    } as Response)

    const { aggregateThemes } = await import('../src/analysis.js')
    const pairs = [makePair('quote-a')]

    const result = await aggregateThemes(pairs, { skipEmbeddings: false })

    expect(result.ok).toBe(false)
  })
})
