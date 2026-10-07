import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('../src/db.js', () => ({
  query: vi.fn(),
  closePool: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('computeAnalysisCacheKey kind label', () => {
  it('[happy] a label key differs from a categorize key built from the same template, model and payload; the categorize key is unchanged (expect: green)', async () => {
    const { computeAnalysisCacheKey, CACHE_KEY_VERSION } = await import('../src/llm-cache.js')
    const template = 'TEMPLATE'
    const model = 'm'
    const payload = '- a\n- b'

    const categorize = computeAnalysisCacheKey({ kind: 'categorize', template, model, payload })
    const label = computeAnalysisCacheKey({ kind: 'label', template, model, payload })

    expect(label).not.toBe(categorize)
    expect(CACHE_KEY_VERSION).toBe('v1')

    const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex')
    const expectedCategorize = sha(
      JSON.stringify(['v1', 'categorize', sha(template), model, JSON.stringify(payload)]),
    )
    expect(categorize).toBe(expectedCategorize)
  })
})
