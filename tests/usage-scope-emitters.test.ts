import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollectedItem, ExtractionResult } from '@mira/shared-core'
import { createUsageRecorder, runWithUsageRecorder } from '@mira/shared-core/usage-scope'
import { reportUsage } from '../src/llm-usage'
import { aggregateThemes } from '../src/analysis'

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function makeItem(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    source: 'reddit',
    url: 'https://example.com/post',
    title: 't',
    body: 'b',
    author: 'a',
    timestamp: new Date().toISOString(),
    engagement: { upvotes: 1, comments: 1 },
    raw_replies: [],
    ...overrides,
  }
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    pain_points: ['too expensive'],
    sentiment: -0.2,
    category: 'pricing',
    mentioned_tools: [],
    key_quote: 'it is too expensive',
    ...overrides,
  }
}

describe('usage-scope emitters (llm-usage.ts, analysis.ts)', () => {
  it('[unhappy] reportUsage with a throwing sink still records to the scope', () => {
    const recorder = createUsageRecorder()
    const throwingSink = (): void => {
      throw new Error('sink blew up')
    }

    return runWithUsageRecorder(recorder, async () => {
      expect(() => {
        reportUsage('gpt-4', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, throwingSink)
      }).not.toThrow()

      const snapshot = recorder.snapshot()
      expect(snapshot.llm).toEqual({
        calls: 1,
        promptTokens: 10,
        completionTokens: 5,
        cacheHitTokens: null,
      })
    })
  })

  it('[unhappy] getEmbeddings non-ok response leaves embeddingRequests unchanged (via aggregateThemes with embeddings on)', async () => {
    vi.stubEnv('JINA_API_KEY', 'test-key')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('server error', { status: 500, statusText: 'Server Error' })),
    )

    const recorder = createUsageRecorder()
    const pairs = [{ item: makeItem(), extraction: makeExtraction() }]

    const result = await runWithUsageRecorder(recorder, () => aggregateThemes(pairs))

    expect(result.ok).toBe(false)
    expect(recorder.snapshot().embeddingRequests).toBe(0)
  })
})
