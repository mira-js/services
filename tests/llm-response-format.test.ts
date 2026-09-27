import { describe, it, expect, vi, beforeEach } from 'vitest'

const create = vi.hoisted(() => vi.fn(async (_params: Record<string, unknown>) => ({
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  usage: undefined,
})))

vi.mock('openai', () => ({
  OpenAI: vi.fn(() => ({ chat: { completions: { create } } })),
}))

import { callLLM } from '../src/llm.js'

describe('callLLM responseFormat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OPENAI_API_KEY = 'test-key'
    create.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: undefined,
    })
  })

  // ─── unhappy ──────────────────────────────────────────────────────────────

  it('[unhappy] omits response_format when responseFormat is not passed (expect: green)', async () => {
    await callLLM([{ role: 'user', content: 'hi' }])
    const params = create.mock.calls[0][0]
    expect(params).not.toHaveProperty('response_format')
  })

  // ─── happy ────────────────────────────────────────────────────────────────

  it('[happy] sends response_format: { type: "json_object" } when responseFormat is "json_object"', async () => {
    await callLLM([{ role: 'user', content: 'hi' }], { responseFormat: 'json_object' })
    const params = create.mock.calls[0][0]
    expect(params).toEqual(
      expect.objectContaining({ response_format: { type: 'json_object' } }),
    )
  })
})
