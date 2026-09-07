import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Prevent real OpenAI client construction — same shape as tests/llm.test.ts:6-13.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('openai', () => {
  const ctor = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }))
  return { default: ctor, OpenAI: ctor }
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.OPENAI_API_KEY = 'test-key'
})

afterEach(() => {
  delete process.env.OPENAI_MODEL
  delete process.env.MIRA_LOG_LLM_USAGE
})

describe('callLLM — usage reporting', () => {
  it('happy path: reports usage with snake→camel mapping and no cache fields', async () => {
    process.env.OPENAI_MODEL = 'deepseek-chat'
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    })
    const { callLLM } = await import('../src/llm.js')
    const onUsage = vi.fn()

    const result = await callLLM([{ role: 'user', content: 'hi' }], { onUsage })

    expect(result).toBe('x')
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith({
      model: 'deepseek-chat',
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    })
    expect(onUsage).toHaveBeenCalledWith(
      expect.not.objectContaining({ cacheHitTokens: expect.anything() }),
    )
    expect(onUsage).toHaveBeenCalledWith(
      expect.not.objectContaining({ cacheMissTokens: expect.anything() }),
    )
  })

  it('DeepSeek cache fields surface as cacheHitTokens / cacheMissTokens', async () => {
    process.env.OPENAI_MODEL = 'deepseek-chat'
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'x' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_cache_hit_tokens: 8,
        prompt_cache_miss_tokens: 2,
      },
    })
    const { callLLM } = await import('../src/llm.js')
    const onUsage = vi.fn()

    await callLLM([{ role: 'user', content: 'hi' }], { onUsage })

    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith({
      model: 'deepseek-chat',
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      cacheHitTokens: 8,
      cacheMissTokens: 2,
    })
  })

  it('no usage key at all: onUsage not called, content still returned, no throw', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'only-content' } }],
    })
    const { callLLM } = await import('../src/llm.js')
    const onUsage = vi.fn()

    const result = await callLLM([{ role: 'user', content: 'hi' }], { onUsage })

    expect(result).toBe('only-content')
    expect(onUsage).not.toHaveBeenCalled()
  })

  it('partial/malformed usage is a silent no-op, content still returned', async () => {
    const { callLLM } = await import('../src/llm.js')

    for (const bad of [{ total_tokens: 5 }, 'nope']) {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'c' } }],
        usage: bad,
      })
      const onUsage = vi.fn()

      const result = await callLLM([{ role: 'user', content: 'hi' }], { onUsage })

      expect(result).toBe('c')
      expect(onUsage).not.toHaveBeenCalled()
    }
  })

  it('a throwing sink does not fail the LLM call', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'resolved-content' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    const { callLLM } = await import('../src/llm.js')
    const onUsage = vi.fn(() => {
      throw new Error('sink boom')
    })

    const result = await callLLM([{ role: 'user', content: 'hi' }], { onUsage })

    expect(result).toBe('resolved-content')
    expect(onUsage).toHaveBeenCalledTimes(1)
  })

  it('env fallback: console.info fires once with MIRA_LOG_LLM_USAGE=1 and no sink, silent when unset', async () => {
    process.env.OPENAI_MODEL = 'deepseek-chat'
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'c' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
    const { callLLM } = await import('../src/llm.js')
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    process.env.MIRA_LOG_LLM_USAGE = '1'
    await callLLM([{ role: 'user', content: 'hi' }])
    expect(infoSpy).toHaveBeenCalledTimes(1)

    // The emitted line must be parseable JSON carrying the fields a cost
    // rollup reads — asserting only the call count would pass on `[object Object]`.
    const [logged] = infoSpy.mock.calls[0]
    expect(typeof logged).toBe('string')
    const parsed: unknown = JSON.parse(String(logged))
    expect(parsed).toMatchObject({
      event: 'llm_usage',
      model: 'deepseek-chat',
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    })

    infoSpy.mockClear()
    delete process.env.MIRA_LOG_LLM_USAGE
    await callLLM([{ role: 'user', content: 'hi' }])
    expect(infoSpy).not.toHaveBeenCalled()

    infoSpy.mockRestore()
  })
})
