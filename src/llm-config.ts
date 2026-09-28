// Zero imports on purpose: evals/runner imports this file by relative source path (ADR-022). Do not add imports.

/**
 * Canonical LLM environment resolver (ADR-022). The only place in TypeScript
 * that reads the LLM key, base URL and model. Precedence per setting is
 * canonical name, then legacy names, then the default. Values are trimmed and
 * an empty or whitespace-only value counts as unset.
 */

export interface LLMConfig {
  readonly apiKey: string | undefined
  readonly baseURL: string
  readonly model: string
  readonly legacyVarsUsed: readonly string[]
}

export interface EvalLLMEndpoint {
  readonly apiKey: string | undefined
  readonly url: string
  readonly model: string
  readonly legacyVarsUsed: readonly string[]
}

export const DEFAULT_LLM_MODEL = 'deepseek-flash'
export const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com'

const API_KEY_NAMES = ['LLM_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'] as const
const BASE_URL_NAMES = ['LLM_BASE_URL', 'OPENAI_BASE_URL'] as const
const MODEL_NAMES = ['LLM_MODEL', 'OPENAI_MODEL', 'DEEPSEEK_MODEL'] as const

interface EnvHit {
  readonly value: string
  readonly name: string
}

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function firstSet(env: NodeJS.ProcessEnv, names: readonly string[]): EnvHit | undefined {
  for (const name of names) {
    const value = readTrimmed(env, name)
    if (value !== undefined) return { value, name }
  }
  return undefined
}

/** Legacy names are every name after the canonical first entry. */
function legacyName(hit: EnvHit | undefined, names: readonly string[]): readonly string[] {
  return hit !== undefined && hit.name !== names[0] ? [hit.name] : []
}

export function resolveLLMConfig(env: NodeJS.ProcessEnv = process.env): LLMConfig {
  const key = firstSet(env, API_KEY_NAMES)
  const baseURL = firstSet(env, BASE_URL_NAMES)
  const model = firstSet(env, MODEL_NAMES)
  return {
    apiKey: key?.value,
    baseURL: baseURL?.value ?? DEFAULT_LLM_BASE_URL,
    model: model?.value ?? DEFAULT_LLM_MODEL,
    legacyVarsUsed: [
      ...legacyName(key, API_KEY_NAMES),
      ...legacyName(baseURL, BASE_URL_NAMES),
      ...legacyName(model, MODEL_NAMES),
    ],
  }
}

/**
 * Endpoint for the eval runners. Model is `EVAL_MODEL`, then the resolved
 * `LLM_MODEL` chain. URL is the legacy full-URL `EVAL_API_URL` when set,
 * otherwise `${baseURL}/chat/completions`.
 */
export function resolveEvalLLMEndpoint(env: NodeJS.ProcessEnv = process.env): EvalLLMEndpoint {
  const cfg = resolveLLMConfig(env)
  const evalUrl = readTrimmed(env, 'EVAL_API_URL')
  const url = evalUrl ?? `${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`
  return {
    apiKey: cfg.apiKey,
    url,
    model: readTrimmed(env, 'EVAL_MODEL') ?? cfg.model,
    legacyVarsUsed: evalUrl === undefined ? cfg.legacyVarsUsed : [...cfg.legacyVarsUsed, 'EVAL_API_URL'],
  }
}

const CANONICAL_FOR: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: 'LLM_API_KEY',
  DEEPSEEK_API_KEY: 'LLM_API_KEY',
  OPENAI_BASE_URL: 'LLM_BASE_URL',
  OPENAI_MODEL: 'LLM_MODEL',
  DEEPSEEK_MODEL: 'LLM_MODEL',
  EVAL_API_URL: 'LLM_BASE_URL',
}

const warnedLegacyNames = new Set<string>()

/** Emits one deprecation warning per legacy name per process. */
export function warnLegacyLLMEnvOnce(names: readonly string[], warn: (msg: string) => void): void {
  for (const name of names) {
    if (warnedLegacyNames.has(name)) continue
    warnedLegacyNames.add(name)
    const canonical = CANONICAL_FOR[name] ?? 'the LLM_* equivalent'
    const hint = name === 'EVAL_API_URL' ? ' (base URL only, without the /chat/completions suffix)' : ''
    warn(`${name} is deprecated and will be removed in the next release; set ${canonical}${hint} instead (ADR-022)`)
  }
}
