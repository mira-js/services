import { OpenAI } from 'openai'
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions'
import { logger } from '@mira/shared-core/logger'
import { reportUsage, type LLMUsageSink } from './llm-usage.js'
import { resolveLLMConfig, shouldDisableThinking, warnLegacyLLMEnvOnce } from './llm-config.js'
import { debugRawEnabled } from './debug.js'

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * `'json_object'` asks the provider for a JSON-only reply (OpenAI/DeepSeek JSON
 * mode). The prompt must then contain the word "json" and request an object
 * root. `'text'` (or omitting it) sends no `response_format` at all.
 */
export type LLMResponseFormat = 'text' | 'json_object'

export interface LLMOptions {
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  onUsage?: LLMUsageSink
  responseFormat?: LLMResponseFormat
}

export type LLMResponseErrorReason = 'no_choices' | 'empty' | 'length'

/**
 * The provider answered, but the reply is unusable: no choices, truncated by the
 * token budget, or empty. The message names the reason, model and finish reason
 * only — never prompt or response text.
 */
export class LLMResponseError extends Error {
  readonly reason: LLMResponseErrorReason
  readonly finishReason: string | null
  readonly model: string

  constructor(reason: LLMResponseErrorReason, model: string, finishReason: string | null) {
    super(`LLM reply unusable (${reason}) from model ${model}, finish_reason=${finishReason ?? 'none'}`)
    this.name = 'LLMResponseError'
    this.reason = reason
    this.finishReason = finishReason
    this.model = model
  }
}

export async function callLLM(messages: LLMMessage[], options?: LLMOptions): Promise<string> {
  const cfg = resolveLLMConfig()
  warnLegacyLLMEnvOnce(cfg.legacyVarsUsed, (m) => logger.warn(m, { event: 'llm_env_deprecated' }))
  const { apiKey, baseURL, model } = cfg
  if (!apiKey) {
    throw new Error('LLM_API_KEY is missing (legacy OPENAI_API_KEY / DEEPSEEK_API_KEY are also read)')
  }
  const client = new OpenAI({ apiKey, baseURL })

  // DeepSeek V4 models think by default, and reasoning tokens count against
  // max_tokens: a 256-token budget is spent entirely on reasoning and `content`
  // comes back empty (finish_reason "length"). Every caller here wants a direct
  // structured answer, so thinking is disabled. Only sent when the host is
  // DeepSeek or LLM_DISABLE_THINKING forces it (proxies in front of DeepSeek) —
  // other OpenAI-compatible providers may reject the unknown field.
  const params: ChatCompletionCreateParamsNonStreaming & { thinking?: { type: 'disabled' } } = {
    model,
    max_tokens: options?.maxTokens ?? 1024,
    temperature: options?.temperature ?? 0,
    messages: options?.systemPrompt
      ? [{ role: 'system', content: options.systemPrompt }, ...messages]
      : messages,
  }
  if (shouldDisableThinking(baseURL)) {
    params.thinking = { type: 'disabled' }
  }
  // Sent for any provider: an OpenAI-compatible endpoint that rejects the field
  // fails the call loudly (llm-error) rather than degrading silently.
  if (options?.responseFormat === 'json_object') {
    params.response_format = { type: 'json_object' }
  }

  const response = await client.chat.completions.create(params)

  reportUsage(model, response.usage, options?.onUsage)

  const choice = response.choices[0]
  if (!choice) throw new LLMResponseError('no_choices', model, null)
  const finishReason = choice.finish_reason ?? null

  // PL-2 Phase 0a diagnostic (temporary, env-gated; off by default). No prompt
  // or response text is emitted here — only the provider's stop reason.
  if (debugRawEnabled()) {
    logger.info('pl2_finish_reason', {
      event: 'pl2_finish_reason',
      model,
      finishReason,
      maxTokens: options?.maxTokens ?? 1024,
    })
  }

  // A truncated reply is a failure even when content is non-empty: a partial
  // JSON object or label parses or reads as valid and corrupts downstream data.
  if (finishReason === 'length') throw new LLMResponseError('length', model, finishReason)

  const content = choice.message.content
  if (content == null || content.trim() === '') throw new LLMResponseError('empty', model, finishReason)

  return content
}
