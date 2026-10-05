import { describe, it, expect } from 'vitest'
import { isDeepSeekHost, shouldDisableThinking } from '../src/llm-config.js'

describe('isDeepSeekHost', () => {
  it('[unhappy] rejects a URL whose path contains deepseek.com', () => {
    expect(isDeepSeekHost('https://proxy.example.com/deepseek.com/v1')).toBe(false)
  })

  it('[unhappy] rejects notdeepseek.com and deepseek.com.evil.io', () => {
    expect(isDeepSeekHost('https://notdeepseek.com')).toBe(false)
    expect(isDeepSeekHost('https://deepseek.com.evil.io')).toBe(false)
  })

  it('[unhappy] returns false without throwing for a malformed URL or empty string', () => {
    expect(() => isDeepSeekHost('not a url')).not.toThrow()
    expect(isDeepSeekHost('not a url')).toBe(false)
    expect(() => isDeepSeekHost('')).not.toThrow()
    expect(isDeepSeekHost('')).toBe(false)
  })

  it('[happy] accepts deepseek.com and its subdomains, with /v1, trailing slash and any case', () => {
    expect(isDeepSeekHost('https://api.deepseek.com')).toBe(true)
    expect(isDeepSeekHost('https://api.deepseek.com/v1')).toBe(true)
    expect(isDeepSeekHost('https://api.deepseek.com/')).toBe(true)
    expect(isDeepSeekHost('https://API.DeepSeek.COM/v1')).toBe(true)
    expect(isDeepSeekHost('https://deepseek.com')).toBe(true)
  })
})

describe('shouldDisableThinking', () => {
  it('[unhappy] LLM_DISABLE_THINKING=false forces off even for a DeepSeek host', () => {
    expect(
      shouldDisableThinking('https://api.deepseek.com', { LLM_DISABLE_THINKING: 'false' }),
    ).toBe(false)
  })

  it('[unhappy] an unrecognised value falls back to hostname auto-detection', () => {
    const env = { LLM_DISABLE_THINKING: 'maybe' }
    expect(shouldDisableThinking('https://openrouter.ai/api/v1', env)).toBe(false)
    expect(shouldDisableThinking('https://api.deepseek.com', env)).toBe(true)
  })

  it('[happy] true and 1 force on for a proxy, and the value is trimmed and case-folded', () => {
    const url = 'https://openrouter.ai/api/v1'
    expect(shouldDisableThinking(url, { LLM_DISABLE_THINKING: 'true' })).toBe(true)
    expect(shouldDisableThinking(url, { LLM_DISABLE_THINKING: '1' })).toBe(true)
    expect(shouldDisableThinking(url, { LLM_DISABLE_THINKING: ' TRUE ' })).toBe(true)
  })

  it('[happy] unset or empty env auto-detects by hostname', () => {
    expect(shouldDisableThinking('https://api.deepseek.com/v1/', {})).toBe(true)
    expect(shouldDisableThinking('https://api.deepseek.com/v1/', { LLM_DISABLE_THINKING: '' })).toBe(true)
    expect(shouldDisableThinking('https://api.openai.com/v1', {})).toBe(false)
    expect(shouldDisableThinking('https://api.openai.com/v1', { LLM_DISABLE_THINKING: '' })).toBe(false)
  })
})
