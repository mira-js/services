import { describe, it, expect } from 'vitest'

describe('computeAnalysisCacheKey responseFormat', () => {
  // ─── unhappy ──────────────────────────────────────────────────────────────

  it('[unhappy] produces a different key for responseFormat "json_object" vs omitted', async () => {
    const { computeAnalysisCacheKey } = await import('../src/llm-cache.js')

    const base = { kind: 'categorize' as const, template: 'tmpl', model: 'm', payload: { a: 1 } }
    const withFormat = computeAnalysisCacheKey({ ...base, responseFormat: 'json_object' })
    const withoutFormat = computeAnalysisCacheKey(base)

    expect(withFormat).not.toBe(withoutFormat)
  })

  // ─── happy ────────────────────────────────────────────────────────────────

  it('[happy] produces the same key for responseFormat "text" and omitted (expect: green)', async () => {
    const { computeAnalysisCacheKey } = await import('../src/llm-cache.js')

    const base = { kind: 'extract' as const, template: 'tmpl', model: 'm', payload: { a: 1 } }
    const withText = computeAnalysisCacheKey({ ...base, responseFormat: 'text' })
    const omitted = computeAnalysisCacheKey(base)

    expect(withText).toBe(omitted)
  })
})
