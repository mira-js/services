import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const create = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  OpenAI: vi.fn(() => ({ chat: { completions: { create } } })),
}))

import { callLLM, LLMResponseError } from '../src/llm'

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }

async function rejection(promise: Promise<string>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected callLLM to reject, but it resolved')
}

function reply(content: string | null, finishReason?: string) {
  return {
    choices: [
      {
        message: { content },
        ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
      },
    ],
    usage: USAGE,
  }
}

describe('callLLM empty / truncated reply guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OPENAI_API_KEY = 'test-key'
  })

  afterEach(() => {
    delete process.env.MIRA_DEBUG_LLM_RAW
  })

  // --- unhappy ---

  it('rejects with LLMResponseError no_choices when choices is empty (not a TypeError)', async () => {
    create.mockResolvedValue({ choices: [], usage: USAGE })

    const err = await rejection(callLLM([{ role: 'user', content: 'hi' }]))

    expect(err).not.toBeInstanceOf(TypeError)
    expect(err).toHaveProperty('name', 'LLMResponseError')
    expect(err).toHaveProperty('reason', 'no_choices')
    expect(err).toHaveProperty('finishReason', null)
  })

  it('still rejects no_choices with MIRA_DEBUG_LLM_RAW=1 (debug log does not dereference choices[0])', async () => {
    process.env.MIRA_DEBUG_LLM_RAW = '1'
    create.mockResolvedValue({ choices: [], usage: USAGE })

    const err = await rejection(callLLM([{ role: 'user', content: 'hi' }]))

    expect(err).not.toBeInstanceOf(TypeError)
    expect(err).toHaveProperty('name', 'LLMResponseError')
    expect(err).toHaveProperty('reason', 'no_choices')
  })

  it('rejects empty when content is null and finish_reason is stop', async () => {
    create.mockResolvedValue(reply(null, 'stop'))

    const err = await rejection(callLLM([{ role: 'user', content: 'hi' }]))

    expect(err).toHaveProperty('name', 'LLMResponseError')
    expect(err).toHaveProperty('reason', 'empty')
    expect(err).toHaveProperty('finishReason', 'stop')
  })

  it('rejects empty when content is whitespace-only', async () => {
    create.mockResolvedValue(reply('   \n', 'stop'))

    const err = await rejection(callLLM([{ role: 'user', content: 'hi' }]))

    expect(err).toHaveProperty('name', 'LLMResponseError')
    expect(err).toHaveProperty('reason', 'empty')
  })

  it('rejects length (not empty) when content is empty and finish_reason is length', async () => {
    create.mockResolvedValue(reply('', 'length'))

    const err = await rejection(callLLM([{ role: 'user', content: 'hi' }]))

    expect(err).toHaveProperty('name', 'LLMResponseError')
    expect(err).toHaveProperty('reason', 'length')
  })

  it('rejects length even when content is non-empty', async () => {
    create.mockResolvedValue(reply('{"partial": ', 'length'))

    const err = await rejection(callLLM([{ role: 'user', content: 'hi' }]))

    expect(err).toHaveProperty('name', 'LLMResponseError')
    expect(err).toHaveProperty('reason', 'length')
    expect(err).toHaveProperty('finishReason', 'length')
  })

  it('fires onUsage once before rejecting on an empty reply', async () => {
    create.mockResolvedValue(reply('', 'stop'))
    const onUsage = vi.fn()

    const err = await rejection(callLLM([{ role: 'user', content: 'hi' }], { onUsage }))

    expect(err).toHaveProperty('reason', 'empty')
    expect(onUsage).toHaveBeenCalledTimes(1)
  })

  it('error is an Error named LLMResponseError whose message leaks neither prompt nor response text', async () => {
    const promptText = 'SECRET_PROMPT_TEXT_XYZ'
    const responseText = 'SECRET_RESPONSE_PARTIAL_ABC'
    create.mockResolvedValue(reply(responseText, 'length'))

    const err = await rejection(callLLM([{ role: 'user', content: promptText }]))

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(LLMResponseError)
    expect(err).toHaveProperty('name', 'LLMResponseError')
    if (!(err instanceof Error)) throw new Error('unreachable')
    expect(err.message).not.toContain(promptText)
    expect(err.message).not.toContain(responseText)
    expect(err.message).toContain('length')
    expect(err.message).toContain('finish_reason=length')
  })

  // --- happy ---

  it('returns non-empty content untrimmed when finish_reason is stop', async () => {
    create.mockResolvedValue(reply('  hello  ', 'stop'))

    await expect(callLLM([{ role: 'user', content: 'hi' }])).resolves.toBe('  hello  ')
  })

  it('returns content when finish_reason is absent (expect: green)', async () => {
    create.mockResolvedValue(reply('ok'))

    await expect(callLLM([{ role: 'user', content: 'hi' }])).resolves.toBe('ok')
  })
})
