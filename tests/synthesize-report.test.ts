import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PainPointTheme } from '@mira/shared-core'

const { mockCallLLM, mockWarn, mockInfo, mockError, mockDebug } = vi.hoisted(() => ({
  mockCallLLM: vi.fn(),
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockDebug: vi.fn(),
}))

vi.mock('../src/llm.js', async (orig) => ({
  ...(await orig<typeof import('../src/llm.js')>()),
  callLLM: mockCallLLM,
}))
vi.mock('@mira/shared-core/logger', () => ({
  logger: { warn: mockWarn, info: mockInfo, error: mockError, debug: mockDebug },
}))
vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue('Q={{query}} T={{themes}}'),
}))
vi.stubGlobal('fetch', vi.fn())

import { synthesizeReport } from '../src/analysis.js'
import { LLMResponseError } from '../src/llm.js'

const FULL_REPORT = [
  '## EXECUTIVE SUMMARY',
  'Sample of 4 items.',
  '## TOP PAIN POINTS',
  '- Slow exports',
  '## COMPETITOR WEAKNESSES',
  '- Weak plugins',
  '## EMERGING GAPS',
  '- No recurring signal',
  '## RECOMMENDATIONS',
  '- Fix exports',
].join('\n')

function makeThemes(): { painPoints: PainPointTheme[]; competitorWeaknesses: PainPointTheme[]; emergingGaps: PainPointTheme[] } {
  return {
    painPoints: [
      {
        theme: 'Slow exports',
        frequency: 4,
        sources: ['reddit'],
        sentiment: -0.6,
        evidence: [{ source: 'reddit', url: 'https://example.com/a', excerpt: 'exports take forever' }],
      },
    ],
    competitorWeaknesses: [],
    emergingGaps: [],
  }
}

function callOptions(callIndex: number): { maxTokens?: number } {
  const options: { maxTokens?: number } | undefined = mockCallLLM.mock.calls[callIndex]?.[1]
  return options ?? {}
}

describe('synthesizeReport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCallLLM.mockReset()
  })

  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] retries once at maxTokens 8192 after a length truncation at 4096 and returns the retry result', async () => {
    mockCallLLM
      .mockRejectedValueOnce(new LLMResponseError('length', 'm', 'length'))
      .mockResolvedValueOnce(FULL_REPORT)

    const result = await synthesizeReport('exports', makeThemes())

    expect(result).toEqual({ ok: true, value: FULL_REPORT })
    expect(mockCallLLM).toHaveBeenCalledTimes(2)
    expect(callOptions(0).maxTokens).toBe(4096)
    expect(callOptions(1).maxTokens).toBe(8192)
    expect(mockCallLLM.mock.calls[1]?.[0]).toEqual(mockCallLLM.mock.calls[0]?.[0])
    expect(mockWarn).toHaveBeenCalled()
  })

  it('[unhappy] surfaces the second error when the 8192 retry also hits the length limit, with no third call', async () => {
    const first = new LLMResponseError('length', 'm', 'length')
    const second = new LLMResponseError('length', 'm', 'length')
    mockCallLLM.mockRejectedValueOnce(first).mockRejectedValueOnce(second)

    const result = await synthesizeReport('exports', makeThemes())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(second)
    expect(mockCallLLM).toHaveBeenCalledTimes(2)
    expect(callOptions(0).maxTokens).toBe(4096)
    expect(callOptions(1).maxTokens).toBe(8192)
    expect(mockWarn).toHaveBeenCalled()
  })

  it('[unhappy] does not retry an empty-reply LLMResponseError and logs synthesis_reply_unusable', async () => {
    const error = new LLMResponseError('empty', 'm', null)
    mockCallLLM.mockRejectedValueOnce(error)

    const result = await synthesizeReport('exports', makeThemes())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(error)
    expect(mockCallLLM).toHaveBeenCalledTimes(1)
    expect(callOptions(0).maxTokens).toBe(4096)
    expect(mockWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'synthesis_reply_unusable', reason: 'empty', finishReason: null, maxTokens: 4096 }),
    )
  })

  it('[unhappy] does not retry a non-LLMResponseError and returns the original error', async () => {
    const error = new Error('network')
    mockCallLLM.mockRejectedValueOnce(error)

    const result = await synthesizeReport('exports', makeThemes())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(error)
    expect(mockCallLLM).toHaveBeenCalledTimes(1)
    expect(callOptions(0).maxTokens).toBe(4096)
  })

  it('[unhappy] warns synthesis_incomplete with the missing sections but still returns the reply unchanged', async () => {
    const partial = ['## EXECUTIVE SUMMARY', 'x', '## TOP PAIN POINTS', 'y', '## COMPETITOR WEAKNESSES', 'z'].join('\n')
    mockCallLLM.mockResolvedValueOnce(partial)

    const result = await synthesizeReport('exports', makeThemes())

    expect(result).toEqual({ ok: true, value: partial })
    expect(mockWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'synthesis_incomplete', missingSections: ['EMERGING GAPS', 'RECOMMENDATIONS'] }),
    )
  })

  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] sends the compact selected input at maxTokens 4096 and logs no warning for a complete reply', async () => {
    mockCallLLM.mockResolvedValueOnce(FULL_REPORT)

    const result = await synthesizeReport('exports', makeThemes())

    expect(result).toEqual({ ok: true, value: FULL_REPORT })
    expect(mockCallLLM).toHaveBeenCalledTimes(1)
    expect(mockCallLLM).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ maxTokens: 4096 }))
    const messages: { content: string }[] = mockCallLLM.mock.calls[0]?.[0] ?? []
    const prompt = messages[0]?.content ?? ''
    expect(prompt.startsWith('Q=exports T={')).toBe(true)
    expect(prompt).toContain('"analyzedItems"')
    expect(prompt).not.toContain('\n  "')
    expect(mockWarn).not.toHaveBeenCalled()
  })
})
