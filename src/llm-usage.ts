import { z } from 'zod'

export interface LLMUsage {
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
}

/**
 * Sink for a single LLM call's token usage.
 *
 * Deliberately sync and `void`-returning: consumers accumulate in memory and
 * flush on their own schedule rather than doing I/O on the LLM call path.
 */
export type LLMUsageSink = (usage: LLMUsage) => void

/**
 * Shape of the `usage` object returned by OpenAI-compatible providers.
 * Not `.strict()` on purpose — real payloads carry extra keys such as
 * `prompt_tokens_details`, and unknown keys are stripped rather than rejected.
 */
const UsageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
  prompt_cache_hit_tokens: z.number().optional(),
  prompt_cache_miss_tokens: z.number().optional(),
})

/**
 * Narrow an unknown provider `usage` payload into `LLMUsage`.
 * Returns `undefined` when the payload is missing, malformed, or partial.
 */
export function parseUsage(model: string, raw: unknown): LLMUsage | undefined {
  const parsed = UsageSchema.safeParse(raw)
  if (!parsed.success) {
    return undefined
  }
  const data = parsed.data
  return {
    model,
    promptTokens: data.prompt_tokens,
    completionTokens: data.completion_tokens,
    totalTokens: data.total_tokens,
    ...(data.prompt_cache_hit_tokens !== undefined
      ? { cacheHitTokens: data.prompt_cache_hit_tokens }
      : {}),
    ...(data.prompt_cache_miss_tokens !== undefined
      ? { cacheMissTokens: data.prompt_cache_miss_tokens }
      : {}),
  }
}

/**
 * Report token usage for one LLM call. Never throws and never logs prompt or
 * response text. Unparseable usage is a silent no-op.
 *
 * A provided sink takes precedence; with no sink, a single JSON diagnostic line
 * is emitted only when `MIRA_LOG_LLM_USAGE === '1'`.
 */
export function reportUsage(model: string, raw: unknown, sink?: LLMUsageSink): void {
  const usage = parseUsage(model, raw)
  if (!usage) {
    return
  }
  if (sink) {
    try {
      sink(usage)
    } catch {
      // a failing sink must never fail the LLM call
    }
    return
  }
  if (process.env.MIRA_LOG_LLM_USAGE === '1') {
    console.info(JSON.stringify({ event: 'llm_usage', ...usage }))
  }
}
