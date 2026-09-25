import { describe, expect, it } from 'vitest'
import {
  createUsageRecorder,
  runWithUsageRecorder,
  recordLlmUsage,
  recordEmbeddingRequest,
  recordApifyCall,
  recordBilledResults,
  recordSourceCache,
} from '@mira/shared-core/usage-scope'

describe('usage-scope (pure ALS carrier)', () => {
  it('[unhappy] record* calls outside any runWithUsageRecorder are no-ops and never throw', () => {
    expect(() => {
      recordLlmUsage({ promptTokens: 1, completionTokens: 1 })
      recordEmbeddingRequest()
      recordApifyCall()
      recordBilledResults(5)
      recordSourceCache(true)
    }).not.toThrow()
  })

  it('[happy] two concurrent runs keep separate totals; llm usage sums calls/tokens, cacheHit stays null until the first report that carries it', async () => {
    const recorderA = createUsageRecorder()
    const recorderB = createUsageRecorder()

    const runA = runWithUsageRecorder(recorderA, async () => {
      recordLlmUsage({ promptTokens: 10, completionTokens: 5 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      recordLlmUsage({ promptTokens: 20, completionTokens: 15, cacheHitTokens: 3 })
      return 'a'
    })

    const runB = runWithUsageRecorder(recorderB, async () => {
      recordLlmUsage({ promptTokens: 100, completionTokens: 50 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      return 'b'
    })

    const [resultA, resultB] = await Promise.all([runA, runB])
    expect(resultA).toBe('a')
    expect(resultB).toBe('b')

    const snapshotA = recorderA.snapshot()
    const snapshotB = recorderB.snapshot()

    expect(snapshotA.llm).toEqual({
      calls: 2,
      promptTokens: 30,
      completionTokens: 20,
      cacheHitTokens: 3,
    })
    expect(snapshotB.llm).toEqual({
      calls: 1,
      promptTokens: 100,
      completionTokens: 50,
      cacheHitTokens: null,
    })
  })
})
