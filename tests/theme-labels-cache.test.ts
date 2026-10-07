import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CollectedItem, ExtractionResult } from '@mira/shared-core'

const { mockQuery, mockCallLLM, mockWarn } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCallLLM: vi.fn(),
  mockWarn: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  query: mockQuery,
  closePool: vi.fn(),
}))

vi.mock('../src/llm.js', () => ({
  callLLM: mockCallLLM,
}))

vi.mock('@mira/shared-core/logger', () => ({
  logger: { warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type Pair = { item: CollectedItem; extraction: ExtractionResult }

function makePair(painPoint: string | undefined, keyQuote = `quote for ${painPoint ?? 'none'}`): Pair {
  return {
    item: {
      source: 'reddit',
      url: `https://example.com/${encodeURIComponent(keyQuote)}`,
      title: 't',
      body: 'b',
      author: 'a',
      timestamp: '2026-01-01T00:00:00.000Z',
      engagement: { upvotes: 1, comments: 0 },
      raw_replies: [],
    },
    extraction: {
      pain_points: painPoint === undefined ? [] : [painPoint],
      sentiment: -0.2,
      category: 'complaint',
      mentioned_tools: [],
      key_quote: keyQuote,
    },
  }
}

// The exact inline prompt the code used before it moved to prompts/theme_label.txt.
const legacyPrompt = (bullets: string): string =>
  'You are labelling a cluster of related user pain points.\n' +
  'Write a 3–6 word label in Title Case that captures the shared theme.\n' +
  'Return ONLY the label — no quotes, no trailing punctuation, no commentary.\n\n' +
  'Pain points:\n' +
  bullets

const isSelect = (sql: unknown): boolean => String(sql).trimStart().toUpperCase().startsWith('SELECT')
const selectCalls = (): unknown[][] => mockQuery.mock.calls.filter((c) => isSelect(c[0]))
const insertCalls = (): unknown[][] => mockQuery.mock.calls.filter((c) => !isSelect(c[0]))

let scratchDir: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  delete process.env.MIRA_PROMPTS_DIR
  process.env.LLM_MODEL = 'test-label-model'
  mockQuery.mockResolvedValue({ ok: true, value: [] })
})

afterEach(() => {
  vi.doUnmock('node:fs')
  delete process.env.MIRA_PROMPTS_DIR
  delete process.env.LLM_MODEL
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true })
  scratchDir = undefined
})

describe('labelClusters with cache', () => {
  it('[unhappy] a failing label read calls callLLM for every cluster and logs a warning with kind label', async () => {
    const { labelClusters } = await import('../src/theme-labels.js')
    mockQuery.mockImplementation(async (sql: string) =>
      isSelect(sql) ? { ok: false, error: new Error('read failed') } : { ok: true, value: [] },
    )
    mockCallLLM.mockResolvedValue('Fresh Label')

    const labels = await labelClusters([[makePair('alpha')], [makePair('beta')]], { cache: {} })

    expect(labels).toEqual(['Fresh Label', 'Fresh Label'])
    expect(mockCallLLM).toHaveBeenCalledTimes(2)
    expect(mockWarn).toHaveBeenCalledWith(
      'llm_cache_unavailable',
      expect.objectContaining({ kind: 'label' }),
    )
  })

  it('[unhappy] a rejecting or empty callLLM leaves that label undefined and writes no row for it', async () => {
    const { labelClusters } = await import('../src/theme-labels.js')
    mockCallLLM.mockImplementation(async (messages: Array<{ content: string }>) => {
      const prompt = messages[0].content
      if (prompt.includes('reject-me')) throw new Error('llm exploded')
      if (prompt.includes('empty-me')) return ''
      return 'Good Label'
    })

    const labels = await labelClusters(
      [[makePair('reject-me')], [makePair('empty-me')], [makePair('fine')]],
      { cache: {} },
    )

    expect(labels).toEqual([undefined, undefined, 'Good Label'])
    expect(insertCalls()).toHaveLength(1)
    const params = insertCalls()[0][1] as unknown[]
    expect(params).toContain(JSON.stringify('Good Label'))
    expect(params).not.toContain(JSON.stringify(''))
    expect(params.filter((p) => p === 'label')).toHaveLength(1)
  })

  it('[happy] one hit and one miss calls callLLM once, then one batched write with kind label and the cleaned label', async () => {
    const { labelClusters } = await import('../src/theme-labels.js')
    // Key-agnostic: answer the SELECT with a hit for the first requested key only.
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (isSelect(sql)) {
        const keys = params[0] as string[]
        return { ok: true, value: [{ cache_key: keys[0], result: 'Cached Label' }] }
      }
      return { ok: true, value: [] }
    })
    mockCallLLM.mockResolvedValue('  "Fresh Label."  ')
    const onUsage = vi.fn()

    const labels = await labelClusters([[makePair('first')], [makePair('second')]], {
      cache: {},
      onUsage,
    })

    expect(labels).toEqual(['Cached Label', 'Fresh Label'])
    expect(selectCalls()).toHaveLength(1)
    expect(mockCallLLM).toHaveBeenCalledTimes(1)
    const callMessages = mockCallLLM.mock.calls[0][0] as Array<{ content: string }>
    expect(callMessages[0].content).toContain('- second')
    expect(mockCallLLM.mock.calls[0][1]).toMatchObject({ onUsage })

    expect(insertCalls()).toHaveLength(1)
    const params = insertCalls()[0][1] as unknown[]
    expect(params).toContain('label')
    expect(params).toContain(JSON.stringify('Fresh Label'))
    expect(params).not.toContain(JSON.stringify('Cached Label'))
  })
})

describe('labelClusters', () => {
  it('[unhappy] a template missing from both MIRA_PROMPTS_DIR and the bundled default gives undefined labels, a warning and no rejection', async () => {
    vi.doMock('node:fs', () => ({
      readFileSync: vi.fn(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }),
    }))
    const { labelClusters } = await import('../src/theme-labels.js')

    const labels = await labelClusters([[makePair('alpha')], [makePair('beta')]])

    expect(labels).toEqual([undefined, undefined])
    expect(mockWarn).toHaveBeenCalled()
    expect(mockCallLLM).not.toHaveBeenCalled()
  })

  it('[happy] the rendered prompt equals the legacy inline string exactly, including $& and $$ in a bullet', async () => {
    const { labelClusters } = await import('../src/theme-labels.js')
    mockCallLLM.mockResolvedValue('Some Label')
    // Six members: only five bullets are used; the first falls back to key_quote.
    const cluster = [
      makePair(undefined, 'fallback quote'),
      makePair('costs $& and $$ more'),
      makePair('three'),
      makePair('four'),
      makePair('five'),
      makePair('six-is-dropped'),
    ]

    await labelClusters([cluster])

    const expectedBullets = [
      '- fallback quote',
      '- costs $& and $$ more',
      '- three',
      '- four',
      '- five',
    ].join('\n')
    expect(mockCallLLM).toHaveBeenCalledTimes(1)
    const [messages, options] = mockCallLLM.mock.calls[0] as [
      Array<{ role: string; content: string }>,
      Record<string, unknown>,
    ]
    expect(messages).toEqual([{ role: 'user', content: legacyPrompt(expectedBullets) }])
    expect(options).toMatchObject({ maxTokens: 32, temperature: 0 })
  })
})

describe('loadThemeLabelTemplate', () => {
  it('[happy] falls back to the bundled theme_label.txt when MIRA_PROMPTS_DIR has none, and renders the legacy prompt', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'mira-empty-prompts-'))
    process.env.MIRA_PROMPTS_DIR = scratchDir
    const { loadThemeLabelTemplate, renderThemeLabelPrompt } = await import('../src/theme-labels.js')

    const template = loadThemeLabelTemplate()
    const bullets = '- one $& two $$ three\n- another'

    expect(template).toContain('{{bullets}}')
    expect(renderThemeLabelPrompt(template, bullets)).toBe(legacyPrompt(bullets))
  })
})
