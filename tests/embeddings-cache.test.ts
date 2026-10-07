import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockQuery, mockRecord, mockWarn, mockInfo } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockRecord: vi.fn(),
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  query: mockQuery,
  closePool: vi.fn(),
}))

vi.mock('@mira/shared-core/usage-scope', () => ({
  recordEmbeddingRequest: mockRecord,
}))

vi.mock('@mira/shared-core/logger', () => ({
  logger: { warn: mockWarn, info: mockInfo, error: vi.fn(), debug: vi.fn() },
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

type CacheRow = { cache_key: string; embedding: unknown }

// Deterministic fake embedding: the first element is the text length.
const vectorOf = (text: string): number[] => [text.length, 1]

function fetchedInputs(callIndex = 0): string[] {
  const init = fetchMock.mock.calls[callIndex]?.[1] as { body: string } | undefined
  const body: { input: string[] } = JSON.parse(init?.body ?? '{}')
  return body.input
}

async function keyFor(text: string): Promise<string> {
  const { computeEmbeddingCacheKey, JINA_EMBEDDING_MODEL, JINA_EMBEDDING_TASK } = await import(
    '../src/embedding-cache.js'
  )
  return computeEmbeddingCacheKey({
    model: JINA_EMBEDDING_MODEL,
    task: JINA_EMBEDDING_TASK,
    dimensions: null,
    text,
  })
}

/** Routes SELECT to `rows` (or a failure) and INSERT to `writeResult`. */
function routeQuery(opts: {
  rows?: CacheRow[]
  readFails?: boolean
  readRejects?: boolean
  writeFails?: boolean
}): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.trimStart().toUpperCase().startsWith('SELECT')) {
      if (opts.readRejects) throw new Error('read exploded')
      if (opts.readFails) return { ok: false, error: new Error('read failed') }
      return { ok: true, value: opts.rows ?? [] }
    }
    if (opts.writeFails) return { ok: false, error: new Error('write failed') }
    return { ok: true, value: [] }
  })
}

const selectCalls = (): unknown[][] =>
  mockQuery.mock.calls.filter((c) => String(c[0]).trimStart().toUpperCase().startsWith('SELECT'))
const insertCalls = (): unknown[][] =>
  mockQuery.mock.calls.filter((c) => String(c[0]).trimStart().toUpperCase().startsWith('INSERT'))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.JINA_API_KEY = 'jina-test-key'
  fetchMock.mockImplementation(async (_url: unknown, init: { body: string }) => {
    const body: { input: string[] } = JSON.parse(init.body)
    return new Response(
      JSON.stringify({ data: body.input.map((t, index) => ({ index, embedding: vectorOf(t) })) }),
      { status: 200 },
    )
  })
})

afterEach(() => {
  delete process.env.JINA_API_KEY
})

describe('getEmbeddings with cache', () => {
  it('[unhappy] a failing cache read fetches every text from Jina in input order and logs llm_cache_unavailable', async () => {
    const { getEmbeddings } = await import('../src/embeddings.js')
    routeQuery({ readFails: true })

    const out = await getEmbeddings(['aa', 'bbbb', 'c'], {})

    expect(out).toEqual([vectorOf('aa'), vectorOf('bbbb'), vectorOf('c')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchedInputs()).toEqual(['aa', 'bbbb', 'c'])
    expect(mockWarn).toHaveBeenCalledWith(
      'llm_cache_unavailable',
      expect.objectContaining({ kind: 'embedding' }),
    )

    // A rejecting query is handled the same way.
    vi.clearAllMocks()
    routeQuery({ readRejects: true })
    const again = await getEmbeddings(['aa', 'bbbb', 'c'], {})
    expect(again).toEqual([vectorOf('aa'), vectorOf('bbbb'), vectorOf('c')])
    expect(mockWarn).toHaveBeenCalledWith(
      'llm_cache_unavailable',
      expect.objectContaining({ kind: 'embedding' }),
    )
  })

  it('[unhappy] a failing cache write still returns the vectors, logs a warning and does not throw', async () => {
    const { getEmbeddings } = await import('../src/embeddings.js')
    routeQuery({ writeFails: true })

    const out = await getEmbeddings(['aa', 'bbbb'], {})

    expect(out).toEqual([vectorOf('aa'), vectorOf('bbbb')])
    expect(insertCalls()).toHaveLength(1)
    expect(mockWarn).toHaveBeenCalledWith(
      'llm_cache_unavailable',
      expect.objectContaining({ kind: 'embedding' }),
    )
  })

  it('[unhappy] a cached row with a non-numeric element or an empty array is a miss and is re-fetched', async () => {
    const { getEmbeddings } = await import('../src/embeddings.js')
    routeQuery({
      rows: [
        { cache_key: await keyFor('poisoned'), embedding: [1, 'x', 3] },
        { cache_key: await keyFor('empty'), embedding: [] },
        { cache_key: await keyFor('good'), embedding: [42, 42] },
      ],
    })

    const out = await getEmbeddings(['poisoned', 'empty', 'good'], {})

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchedInputs()).toEqual(['poisoned', 'empty'])
    expect(out).toEqual([vectorOf('poisoned'), vectorOf('empty'), [42, 42]])
  })

  it('[unhappy] a partial hit without JINA_API_KEY throws JINA_API_KEY is required', async () => {
    const { getEmbeddings } = await import('../src/embeddings.js')
    delete process.env.JINA_API_KEY
    routeQuery({ rows: [{ cache_key: await keyFor('hit'), embedding: [9, 9] }] })

    await expect(getEmbeddings(['hit', 'miss'], {})).rejects.toThrow('JINA_API_KEY is required')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('[happy] two of three distinct texts hit and the duplicate miss is fetched once, output index-aligned', async () => {
    const { getEmbeddings } = await import('../src/embeddings.js')
    routeQuery({
      rows: [
        { cache_key: await keyFor('hit-a'), embedding: [1, 1] },
        { cache_key: await keyFor('hit-c'), embedding: [3, 3] },
      ],
    })

    const out = await getEmbeddings(['hit-a', 'miss', 'hit-c', 'miss'], {})

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchedInputs()).toEqual(['miss'])
    expect(out).toEqual([[1, 1], vectorOf('miss'), [3, 3], vectorOf('miss')])
    expect(mockRecord).toHaveBeenCalledTimes(1)
    expect(insertCalls()).toHaveLength(1)
  })

  it('[happy] all hits make no fetch, no recordEmbeddingRequest and need no JINA_API_KEY', async () => {
    const { getEmbeddings } = await import('../src/embeddings.js')
    delete process.env.JINA_API_KEY
    routeQuery({
      rows: [
        { cache_key: await keyFor('one'), embedding: [1, 2] },
        { cache_key: await keyFor('two'), embedding: [3, 4] },
      ],
    })

    const out = await getEmbeddings(['one', 'two', 'one'], {})

    expect(out).toEqual([[1, 2], [3, 4], [1, 2]])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('[happy] bust:true skips the SELECT, fetches everything and writes the rows', async () => {
    const { getEmbeddings } = await import('../src/embeddings.js')
    routeQuery({ rows: [{ cache_key: await keyFor('one'), embedding: [7, 7] }] })

    const out = await getEmbeddings(['one', 'two'], { bust: true })

    expect(selectCalls()).toHaveLength(0)
    expect(fetchedInputs()).toEqual(['one', 'two'])
    expect(out).toEqual([vectorOf('one'), vectorOf('two')])
    expect(insertCalls()).toHaveLength(1)
  })
})
