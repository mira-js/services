import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
}))

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
  OpenAI: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}))

describe('callLLM', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
  })

  it('uses OPENAI_API_KEY when set', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
    vi.stubEnv('OPENAI_MODEL', 'gpt-4o')
    const { callLLM } = await import('./llm.js')
    const result = await callLLM([{ role: 'user', content: 'hi' }])
    expect(result).toBe('ok')
  })

  it('falls back to DEEPSEEK_API_KEY when OPENAI_API_KEY absent', async () => {
    delete process.env.OPENAI_API_KEY
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-deepseek-key')
    const { callLLM } = await import('./llm.js')
    await expect(callLLM([{ role: 'user', content: 'hi' }])).resolves.toBeDefined()
  })

  it('throws when both API keys absent', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const { callLLM } = await import('./llm.js')
    await expect(callLLM([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'OPENAI_API_KEY (or DEEPSEEK_API_KEY) is missing',
    )
  })

  it('uses DEEPSEEK_MODEL fallback when OPENAI_MODEL not set', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'key')
    vi.stubEnv('OPENAI_MODEL', '')
    vi.stubEnv('DEEPSEEK_MODEL', 'deepseek-coder')
    const { callLLM } = await import('./llm.js')
    await callLLM([{ role: 'user', content: 'hi' }])
    // mockCreate was called — the model env logic ran without throwing
    expect(mockCreate).toHaveBeenCalled()
  })

  it('disables thinking when talking to DeepSeek', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.deepseek.com')
    const { callLLM } = await import('./llm.js')
    await callLLM([{ role: 'user', content: 'hi' }])
    expect(mockCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinking: { type: 'disabled' } }),
    )
  })

  it('omits the thinking field for non-DeepSeek providers', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
    const { callLLM } = await import('./llm.js')
    await callLLM([{ role: 'user', content: 'hi' }])
    expect(mockCreate.mock.lastCall?.[0]).not.toHaveProperty('thinking')
  })
})
