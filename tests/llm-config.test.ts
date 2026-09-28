import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveLLMConfig, resolveEvalLLMEndpoint, warnLegacyLLMEnvOnce } from '../src/llm-config.js'

describe('llm-config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('[unhappy] resolveLLMConfig falls back to DEEPSEEK_API_KEY when OPENAI_API_KEY is empty', () => {
    const cfg = resolveLLMConfig({ OPENAI_API_KEY: '', DEEPSEEK_API_KEY: 'dk' })
    expect(cfg.apiKey).toBe('dk')
  })

  it('[unhappy] resolveLLMConfig returns undefined apiKey when all key vars are unset or whitespace', () => {
    const cfg = resolveLLMConfig({ LLM_API_KEY: '   ', OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '   ' })
    expect(cfg.apiKey).toBeUndefined()
  })

  it('[unhappy] resolveLLMConfig falls back to the default base URL when OPENAI_BASE_URL is empty', () => {
    const cfg = resolveLLMConfig({ OPENAI_BASE_URL: '' })
    expect(cfg.baseURL).toBe('https://api.deepseek.com')
  })

  it('[unhappy] warnLegacyLLMEnvOnce warns once per name even when passed twice, and never warns for an empty list', () => {
    const sink = vi.fn()
    warnLegacyLLMEnvOnce(['TEST_LEGACY_NAME_A'], sink)
    warnLegacyLLMEnvOnce(['TEST_LEGACY_NAME_A'], sink)
    expect(sink).toHaveBeenCalledTimes(1)

    const neverSink = vi.fn()
    warnLegacyLLMEnvOnce([], neverSink)
    expect(neverSink).not.toHaveBeenCalled()
  })

  it('[unhappy] resolveEvalLLMEndpoint uses EVAL_API_URL verbatim and records it as legacy', () => {
    const result = resolveEvalLLMEndpoint({ EVAL_API_URL: 'https://legacy-eval.test/chat' })
    expect(result.url).toBe('https://legacy-eval.test/chat')
    expect(result.legacyVarsUsed).toContain('EVAL_API_URL')
  })

  it('[happy] resolveLLMConfig lets canonical LLM_* values win over legacy names', () => {
    const cfg = resolveLLMConfig({
      LLM_API_KEY: 'canonical-key',
      LLM_BASE_URL: 'https://canonical.test',
      LLM_MODEL: 'canonical-model',
      OPENAI_API_KEY: 'legacy-key',
      OPENAI_BASE_URL: 'https://legacy.test',
      OPENAI_MODEL: 'legacy-model',
      DEEPSEEK_API_KEY: 'legacy-key-2',
      DEEPSEEK_MODEL: 'legacy-model-2',
    })
    expect(cfg.apiKey).toBe('canonical-key')
    expect(cfg.baseURL).toBe('https://canonical.test')
    expect(cfg.model).toBe('canonical-model')
    expect(cfg.legacyVarsUsed).toEqual([])
  })

  it('[happy] resolveLLMConfig uses OPENAI_MODEL when only it is set, recording it as legacy', () => {
    const cfg = resolveLLMConfig({ OPENAI_MODEL: 'oa-model' })
    expect(cfg.model).toBe('oa-model')
    expect(cfg.legacyVarsUsed).toEqual(['OPENAI_MODEL'])
  })

  it('[happy] resolveLLMConfig uses DEEPSEEK_MODEL when only it is set, recording it as legacy', () => {
    const cfg = resolveLLMConfig({ DEEPSEEK_MODEL: 'dk-model' })
    expect(cfg.model).toBe('dk-model')
    expect(cfg.legacyVarsUsed).toEqual(['DEEPSEEK_MODEL'])
  })

  it('[happy] resolveLLMConfig resolves defaults from an empty env', () => {
    const cfg = resolveLLMConfig({})
    expect(cfg).toEqual({
      apiKey: undefined,
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      legacyVarsUsed: [],
    })
  })

  it('[happy] resolveEvalLLMEndpoint builds the URL from LLM_BASE_URL and lets EVAL_MODEL override the model', () => {
    const result = resolveEvalLLMEndpoint({
      LLM_BASE_URL: 'https://x.test/v1/',
      EVAL_MODEL: 'eval-model',
    })
    expect(result.url).toBe('https://x.test/v1/chat/completions')
    expect(result.model).toBe('eval-model')
  })
})
