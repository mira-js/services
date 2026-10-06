import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PainPointTheme } from '@mira/shared-core'

const { mockCallLLM, mockWarn, mockInfo, mockError, mockDebug, mockReadFileSync } = vi.hoisted(() => ({
  mockCallLLM: vi.fn(),
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockDebug: vi.fn(),
  mockReadFileSync: vi.fn(),
}))

vi.mock('../src/llm.js', async (orig) => ({
  ...(await orig<typeof import('../src/llm.js')>()),
  callLLM: mockCallLLM,
}))
vi.mock('@mira/shared-core/logger', () => ({
  logger: { warn: mockWarn, info: mockInfo, error: mockError, debug: mockDebug },
}))
vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
}))
vi.stubGlobal('fetch', vi.fn())

import { synthesizeStructuredReport } from '../src/analysis.js'
import { LLMResponseError } from '../src/llm.js'
import { selectSynthesisInput, findMissingSections } from '../src/synthesis-input.js'

const STRUCTURED_TEMPLATE = 'STRUCTURED Q={{query}} T={{themes}} Return only json.'
const PROSE_TEMPLATE = 'PROSE Q={{query}} T={{themes}}'

const PROSE_REPORT = [
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

const VALID_REPLY = JSON.stringify({
  executive_summary: 'Sample of 4 items from reddit. Exports are slow.',
  recommended_actions: [{ action: 'Fix exports', rationale: 'Most frequent complaint.', theme_ids: ['pp-0'] }],
})

const SCHEMA_INVALID_REPLY = JSON.stringify({ executive_summary: 'Only a summary.', recommended_actions: [] })

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

function useBothTemplates(): void {
  mockReadFileSync.mockImplementation((path: unknown) => {
    return String(path).endsWith('synthesize_report_structured.txt') ? STRUCTURED_TEMPLATE : PROSE_TEMPLATE
  })
}

function callOptions(callIndex: number): { maxTokens?: number; responseFormat?: string } {
  const options: { maxTokens?: number; responseFormat?: string } | undefined = mockCallLLM.mock.calls[callIndex]?.[1]
  return options ?? {}
}

function promptOf(callIndex: number): string {
  const messages: { content: string }[] = mockCallLLM.mock.calls[callIndex]?.[0] ?? []
  return messages[0]?.content ?? ''
}

// The log shape is not pinned by the contract: accept the event name as the
// message or as an `event` field on the context object.
function findLogContext(mock: ReturnType<typeof vi.fn>, name: string): Record<string, unknown> | undefined {
  for (const call of mock.mock.calls) {
    const context: unknown = call[1]
    const record: Record<string, unknown> =
      typeof context === 'object' && context !== null ? Object.fromEntries(Object.entries(context)) : {}
    if (call[0] === name || record.event === name) return record
  }
  return undefined
}

describe('synthesizeStructuredReport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCallLLM.mockReset()
    mockReadFileSync.mockReset()
    useBothTemplates()
  })

  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] a schema-invalid structured reply falls back to one prose call with no responseFormat and returns report null', async () => {
    mockCallLLM.mockResolvedValueOnce(SCHEMA_INVALID_REPLY).mockResolvedValueOnce(PROSE_REPORT)

    const result = await synthesizeStructuredReport('exports', makeThemes())

    expect(result).toEqual({ ok: true, value: { summary: PROSE_REPORT, report: null } })
    expect(mockCallLLM).toHaveBeenCalledTimes(2)
    expect(promptOf(0).startsWith('STRUCTURED')).toBe(true)
    expect(promptOf(1).startsWith('PROSE')).toBe(true)
    expect(callOptions(1).responseFormat).toBeUndefined()
    const fallbackLog = findLogContext(mockWarn, 'synthesis_structured_fallback')
    expect(fallbackLog).toBeDefined()
    expect(fallbackLog?.stage).toBe('schema')
  })

  it('[unhappy] a missing structured prompt file falls back with stage prompt and makes exactly one (prose) call', async () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path).endsWith('synthesize_report_structured.txt')) {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
      }
      return PROSE_TEMPLATE
    })
    mockCallLLM.mockResolvedValueOnce(PROSE_REPORT)

    const result = await synthesizeStructuredReport('exports', makeThemes())

    expect(result).toEqual({ ok: true, value: { summary: PROSE_REPORT, report: null } })
    expect(mockCallLLM).toHaveBeenCalledTimes(1)
    expect(promptOf(0).startsWith('PROSE')).toBe(true)
    const fallbackLog = findLogContext(mockWarn, 'synthesis_structured_fallback')
    expect(fallbackLog).toBeDefined()
    expect(fallbackLog?.stage).toBe('prompt')
  })

  it('[unhappy] a network error returns ok:false with that error, one call, and no fallback', async () => {
    const error = new Error('network')
    mockCallLLM.mockRejectedValueOnce(error)

    const result = await synthesizeStructuredReport('exports', makeThemes())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(error)
    expect(mockCallLLM).toHaveBeenCalledTimes(1)
    expect(findLogContext(mockWarn, 'synthesis_structured_fallback')).toBeUndefined()
  })

  it('[unhappy] an empty-reply LLMResponseError is not retried, does not fall back, and logs synthesis_reply_unusable', async () => {
    const error = new LLMResponseError('empty', 'm', null)
    mockCallLLM.mockRejectedValueOnce(error)

    const result = await synthesizeStructuredReport('exports', makeThemes())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(error)
    expect(mockCallLLM).toHaveBeenCalledTimes(1)
    expect(findLogContext(mockWarn, 'synthesis_structured_fallback')).toBeUndefined()
    expect(findLogContext(mockWarn, 'synthesis_reply_unusable')).toBeDefined()
  })

  it('[unhappy] a length truncation at 4096 is retried at 8192 with the same messages and json_object, and the retry reply yields a structured result', async () => {
    mockCallLLM
      .mockRejectedValueOnce(new LLMResponseError('length', 'm', 'length'))
      .mockResolvedValueOnce(VALID_REPLY)

    const result = await synthesizeStructuredReport('exports', makeThemes())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.report).not.toBeNull()
    expect(mockCallLLM).toHaveBeenCalledTimes(2)
    expect(callOptions(0).maxTokens).toBe(4096)
    expect(callOptions(1).maxTokens).toBe(8192)
    expect(callOptions(0).responseFormat).toBe('json_object')
    expect(callOptions(1).responseFormat).toBe('json_object')
    expect(mockCallLLM.mock.calls[1]?.[0]).toEqual(mockCallLLM.mock.calls[0]?.[0])
  })

  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] a valid JSON reply makes one json_object call and returns the rendered markdown summary with the report', async () => {
    // Imported here so a missing new module fails only this case, not the whole file.
    const { renderReportMarkdown } = await import('../src/synthesis-report.js')
    mockCallLLM.mockResolvedValueOnce(VALID_REPLY)
    const themes = makeThemes()

    const result = await synthesizeStructuredReport('exports', themes)

    const expectedReport = {
      executiveSummary: 'Sample of 4 items from reddit. Exports are slow.',
      recommendedActions: [
        {
          action: 'Fix exports',
          rationale: 'Most frequent complaint.',
          themes: [{ bucket: 'painPoints', index: 0 }],
        },
      ],
    }
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.report).toEqual(expectedReport)
    expect(result.value.summary).toBe(renderReportMarkdown(expectedReport, selectSynthesisInput(themes)))
    expect(findMissingSections(result.value.summary)).toEqual([])

    expect(mockCallLLM).toHaveBeenCalledTimes(1)
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ maxTokens: 4096, responseFormat: 'json_object' }),
    )
    expect(promptOf(0).startsWith('STRUCTURED')).toBe(true)

    const infoLog = findLogContext(mockInfo, 'synthesis_structured')
    expect(infoLog).toBeDefined()
    expect(infoLog?.replyChars).toBe(VALID_REPLY.length)
  })
})
