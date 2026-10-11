import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/llm.js', () => ({ callLLM: vi.fn() }))
vi.mock('@mira/shared-core/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.stubGlobal('fetch', vi.fn())

process.env.JINA_API_KEY = 'test-key'

const { aggregateThemes } = await import('../src/analysis.js')
const { logger } = await import('@mira/shared-core/logger')
const { callLLM } = await import('../src/llm.js')

type PairInput = { keyQuote: string; painPoints?: string[]; url?: string }

function makePair({ keyQuote, painPoints = ['sync stalls'], url }: PairInput) {
  return {
    item: {
      source: 'reddit' as const,
      url: url ?? `https://example.com/${keyQuote}`,
      title: `title ${keyQuote}`,
      body: `body ${keyQuote}`,
      author: 'author',
      timestamp: '2026-01-01T00:00:00.000Z',
      engagement: { upvotes: 1, comments: 0 },
      raw_replies: [],
    },
    extraction: {
      pain_points: painPoints,
      sentiment: -0.3,
      category: 'complaint' as const,
      mentioned_tools: [],
      key_quote: keyQuote,
    },
  }
}

const at = (deg: number): number[] => {
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
}

function inputsOf(init: unknown): string[] {
  if (typeof init !== 'object' || init === null || !('body' in init) || typeof init.body !== 'string') return []
  const parsed: unknown = JSON.parse(init.body)
  if (typeof parsed !== 'object' || parsed === null || !('input' in parsed) || !Array.isArray(parsed.input)) return []
  return parsed.input.map((entry: unknown) => {
    if (typeof entry === 'string') return entry
    if (typeof entry === 'object' && entry !== null && 'text' in entry && typeof entry.text === 'string') return entry.text
    return ''
  })
}

// Vectors are looked up by a unique token that appears in the embedded text (the key_quote).
function stubEmbeddings(vectorByToken: Record<string, number[]>, seen: string[] = []): void {
  vi.mocked(fetch).mockImplementation(async (_url: unknown, init?: unknown) => {
    const inputs = inputsOf(init)
    seen.push(...inputs)
    const data = inputs.map((text, index) => {
      const token = Object.keys(vectorByToken).find((t) => text.includes(t))
      return { index, embedding: token === undefined ? [1, 0, 0] : vectorByToken[token] }
    })
    return { ok: true, status: 200, json: async () => ({ data }) } as Response
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Labelling is not under test: make every LLM call fail so cluster labels fall back to defaults.
  vi.mocked(callLLM).mockRejectedValue(new Error('llm disabled in clustering tests'))
})

describe('aggregateThemes — clustering wiring', () => {
  it('[happy] the embedding path logs theme_clustering with the stats and the active constants; skipEmbeddings does not', async () => {
    const { THEME_CLUSTER_THRESHOLD, THEME_MERGE_THRESHOLD, THEME_SEED_ORDER, THEME_EMBED_TEXT } = await import('../src/clustering.js')
    stubEmbeddings({ alpha: [1, 0, 0], beta: [1, 0, 0], gamma: [0, 1, 0] })
    const pairs = [makePair({ keyQuote: 'alpha' }), makePair({ keyQuote: 'beta' }), makePair({ keyQuote: 'gamma' })]

    const result = await aggregateThemes(pairs)
    expect(result.ok).toBe(true)

    const call = vi.mocked(logger.info).mock.calls.find((c) => c[0] === 'theme_clustering')
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual(
      expect.objectContaining({
        items: 3,
        clusters: 2,
        singletons: 1,
        threshold: THEME_CLUSTER_THRESHOLD,
        mergeThreshold: THEME_MERGE_THRESHOLD,
        seedOrder: THEME_SEED_ORDER,
        embedText: THEME_EMBED_TEXT,
      }),
    )

    vi.mocked(logger.info).mockClear()
    const skipped = await aggregateThemes(pairs, { skipEmbeddings: true })
    expect(skipped.ok).toBe(true)
    expect(vi.mocked(logger.info).mock.calls.some((c) => c[0] === 'theme_clustering')).toBe(false)
  })

  it('[happy] the Jina input for pain_points [a, b] and key_quote q is exactly "a b q" (expect: green)', async () => {
    const seen: string[] = []
    stubEmbeddings({ q: [1, 0, 0] }, seen)

    const result = await aggregateThemes([makePair({ keyQuote: 'q', painPoints: ['a', 'b'] })])

    expect(result.ok).toBe(true)
    expect(seen).toEqual(['a b q'])
  })

  it('[happy] with the shipped constants seeds in input order: 0, 25 and 50 degrees give frequencies [2, 1] (expect: green)', async () => {
    // cos(0,25) = cos(25,50) = 0.906, cos(0,50) = 0.643. Centroid seeding would seed the middle item and give one theme of 3.
    stubEmbeddings({ first: at(0), second: at(25), third: at(50) })
    const pairs = [makePair({ keyQuote: 'first' }), makePair({ keyQuote: 'second' }), makePair({ keyQuote: 'third' })]

    const result = await aggregateThemes(pairs)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map((t) => t.frequency)).toEqual([2, 1])
    expect(result.value[0].theme).toBe('first')
    expect(result.value[1].theme).toBe('third')
  })

  it('[happy] skipEmbeddings: true still groups by identical key_quote (expect: green)', async () => {
    const pairs = [
      makePair({ keyQuote: 'same quote', url: 'https://example.com/1' }),
      makePair({ keyQuote: 'same quote', url: 'https://example.com/2' }),
      makePair({ keyQuote: 'other quote', url: 'https://example.com/3' }),
    ]

    const result = await aggregateThemes(pairs, { skipEmbeddings: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map((t) => t.frequency)).toEqual([2, 1])
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
})
