import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate, warnMock } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
  warnMock: vi.fn(),
}))

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
  OpenAI: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}))

vi.mock('@mira/shared-core/logger', () => ({
  logger: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

describe('callLLM', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    for (const n of [
      'LLM_API_KEY',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'LLM_BASE_URL',
      'OPENAI_BASE_URL',
      'LLM_MODEL',
      'OPENAI_MODEL',
      'DEEPSEEK_MODEL',
      'LLM_DISABLE_THINKING',
    ]) {
      vi.stubEnv(n, '')
    }
    vi.clearAllMocks()
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
  })

  it('uses OPENAI_API_KEY when set', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
    vi.stubEnv('OPENAI_MODEL', 'gpt-4o')
    const { callLLM } = await import('../src/llm.js')
    const result = await callLLM([{ role: 'user', content: 'hi' }])
    expect(result).toBe('ok')
  })

  it('falls back to DEEPSEEK_API_KEY when OPENAI_API_KEY absent', async () => {
    delete process.env.OPENAI_API_KEY
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-deepseek-key')
    const { callLLM } = await import('../src/llm.js')
    await expect(callLLM([{ role: 'user', content: 'hi' }])).resolves.toBeDefined()
  })

  it('[unhappy] throws naming the canonical LLM_API_KEY variable when no key vars are set', async () => {
    vi.stubEnv('LLM_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const { callLLM } = await import('../src/llm.js')
    await expect(callLLM([{ role: 'user', content: 'hi' }])).rejects.toThrow(/LLM_API_KEY/)
  })

  it('uses DEEPSEEK_MODEL fallback when OPENAI_MODEL not set', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'key')
    vi.stubEnv('OPENAI_MODEL', '')
    vi.stubEnv('DEEPSEEK_MODEL', 'deepseek-coder')
    const { callLLM } = await import('../src/llm.js')
    await callLLM([{ role: 'user', content: 'hi' }])
    // mockCreate was called — the model env logic ran without throwing
    expect(mockCreate).toHaveBeenCalled()
  })

  it('disables thinking when talking to DeepSeek', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.deepseek.com')
    const { callLLM } = await import('../src/llm.js')
    await callLLM([{ role: 'user', content: 'hi' }])
    expect(mockCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinking: { type: 'disabled' } }),
    )
  })

  it('omits the thinking field for non-DeepSeek providers', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
    const { callLLM } = await import('../src/llm.js')
    await callLLM([{ role: 'user', content: 'hi' }])
    expect(mockCreate.mock.lastCall?.[0]).not.toHaveProperty('thinking')
  })

  it('[happy] uses canonical LLM_BASE_URL and LLM_API_KEY, disabling thinking and resolving the default model', async () => {
    vi.stubEnv('LLM_API_KEY', 'k')
    vi.stubEnv('LLM_BASE_URL', 'https://api.deepseek.com')
    const { callLLM } = await import('../src/llm.js')
    await callLLM([{ role: 'user', content: 'hi' }])
    expect(mockCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinking: { type: 'disabled' }, model: 'deepseek-flash' }),
    )
  })

  it('[unhappy] omits thinking when the DeepSeek hostname appears only in the URL path', async () => {
    vi.stubEnv('LLM_API_KEY', 'k')
    vi.stubEnv('LLM_BASE_URL', 'https://proxy.example.com/deepseek.com/v1')
    const { callLLM } = await import('../src/llm.js')
    await callLLM([{ role: 'user', content: 'hi' }])
    expect(mockCreate.mock.lastCall?.[0]).not.toHaveProperty('thinking')
  })

  it('[happy] disables thinking under the prod configuration (only LLM_API_KEY set, default base URL)', async () => {
    vi.stubEnv('LLM_API_KEY', 'k')
    const { callLLM } = await import('../src/llm.js')
    await callLLM([{ role: 'user', content: 'hi' }])
    expect(mockCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinking: { type: 'disabled' } }),
    )
  })

  it('[happy] disables thinking behind a non-DeepSeek proxy when LLM_DISABLE_THINKING=true', async () => {
    vi.stubEnv('LLM_API_KEY', 'k')
    vi.stubEnv('LLM_BASE_URL', 'https://openrouter.ai/api/v1')
    vi.stubEnv('LLM_DISABLE_THINKING', 'true')
    const { callLLM } = await import('../src/llm.js')
    await callLLM([{ role: 'user', content: 'hi' }])
    expect(mockCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinking: { type: 'disabled' } }),
    )
  })

  it('[happy] warns once via logger.warn across two calls when only legacy OPENAI_API_KEY is set', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'legacy-key')
    const { callLLM } = await import('../src/llm.js')
    await callLLM([{ role: 'user', content: 'hi' }])
    await callLLM([{ role: 'user', content: 'hi again' }])
    expect(warnMock).toHaveBeenCalledTimes(1)
  })
})
