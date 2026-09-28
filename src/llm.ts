import { OpenAI } from 'openai'
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions'
import { logger } from '@mira/shared-core/logger'
import { reportUsage, type LLMUsageSink } from './llm-usage.js'
import { resolveModelName } from './llm-cache.js'

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

export async function callLLM(messages: LLMMessage[], options?: LLMOptions): Promise<string> {
  const apiKey = (process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY)?.trim()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY (or DEEPSEEK_API_KEY) is missing')
  }
  const baseURL = process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com'
  const client = new OpenAI({ apiKey, baseURL })
  const model = resolveModelName()

  // DeepSeek V4 models think by default, and reasoning tokens count against
  // max_tokens: a 256-token budget is spent entirely on reasoning and `content`
  // comes back empty (finish_reason "length"). Every caller here wants a direct
  // structured answer, so thinking is disabled. Only sent to DeepSeek — other
  // OpenAI-compatible providers may reject the unknown field.
  const params: ChatCompletionCreateParamsNonStreaming & { thinking?: { type: 'disabled' } } = {
    model,
    max_tokens: options?.maxTokens ?? 1024,
    temperature: options?.temperature ?? 0,
    messages: options?.systemPrompt
      ? [{ role: 'system', content: options.systemPrompt }, ...messages]
      : messages,
  }
  if (baseURL.includes('deepseek.com')) {
    params.thinking = { type: 'disabled' }
  }
  // Sent for any provider: an OpenAI-compatible endpoint that rejects the field
  // fails the call loudly (llm-error) rather than degrading silently.
  if (options?.responseFormat === 'json_object') {
    params.response_format = { type: 'json_object' }
  }

  const response = await client.chat.completions.create(params)

  reportUsage(model, response.usage, options?.onUsage)

  // PL-2 Phase 0a diagnostic (temporary, env-gated; off by default). No prompt
  // or response text is emitted here — only the provider's stop reason.
  if (process.env.MIRA_DEBUG_LLM_RAW === '1') {
    logger.info('pl2_finish_reason', {
      event: 'pl2_finish_reason',
      model,
      finishReason: response.choices[0].finish_reason,
      maxTokens: options?.maxTokens ?? 1024,
    })
  }

  return response.choices[0].message.content ?? ''
}
