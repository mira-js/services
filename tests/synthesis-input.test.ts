import { describe, it, expect } from 'vitest'
import type { PainPointTheme } from '@mira/shared-core'
import { selectSynthesisInput, findMissingSections } from '../src/synthesis-input.js'

function theme(overrides: Partial<PainPointTheme> & { theme: string }): PainPointTheme {
  return {
    frequency: 2,
    sources: ['reddit'],
    sentiment: -0.5,
    evidence: [{ source: 'reddit', url: 'https://example.com/a', excerpt: 'short quote' }],
    ...overrides,
  }
}

const emptyBuckets = () => ({ painPoints: [], competitorWeaknesses: [], emergingGaps: [] })

describe('selectSynthesisInput', () => {
  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] excludes positive pain-point themes and counts them in excludedPositive, not longTail', () => {
    const buckets = {
      ...emptyBuckets(),
      painPoints: [
        theme({ theme: 'Loved thing A', frequency: 5, sentiment: 0.5 }),
        theme({ theme: 'Loved thing B', frequency: 5, sentiment: 0.9 }),
        theme({ theme: 'Slow exports', frequency: 3, sentiment: -0.6 }),
      ],
      competitorWeaknesses: [theme({ theme: 'Praised plugin system', frequency: 4, sentiment: 0.7 })],
    }

    const input = selectSynthesisInput(buckets)

    const names = input.painPoints.themes.map((t) => t.name)
    expect(names).toEqual(['Slow exports'])
    expect(names).not.toContain('Loved thing A')
    expect(names).not.toContain('Loved thing B')
    expect(input.painPoints.excludedPositive).toBe(2)
    expect(input.painPoints.longTail.themes).toBe(0)
    expect(input.painPoints.longTail.mentions).toBe(0)

    // Other buckets keep positive themes.
    expect(input.competitorWeaknesses.themes.map((t) => t.name)).toEqual(['Praised plugin system'])
    expect(input.competitorWeaknesses.excludedPositive).toBe(0)
  })

  it('[unhappy] caps a bucket at 10 themes by frequency and summarises the rest as longTail', () => {
    // 14 themes with frequency 3..16, deliberately unordered.
    const freqs = [9, 3, 16, 5, 12, 7, 14, 4, 10, 6, 15, 8, 11, 13]
    const strong = freqs.map((f) =>
      theme({
        theme: `Theme ${f}`,
        frequency: f,
        sources: f <= 6 ? ['reddit', 'hackernews'] : ['reddit'],
      }),
    )
    const singles = [
      ...[1, 2, 3].map((i) => theme({ theme: `Single reddit ${i}`, frequency: 1, sources: ['reddit'] })),
      ...[1, 2, 3].map((i) => theme({ theme: `Single rss ${i}`, frequency: 1, sources: ['rss'] })),
    ]

    const input = selectSynthesisInput({ ...emptyBuckets(), painPoints: [...singles, ...strong] })

    const kept = input.painPoints.themes
    expect(kept).toHaveLength(10)
    expect(kept.map((t) => t.frequency)).toEqual([16, 15, 14, 13, 12, 11, 10, 9, 8, 7])
    // Tail: overflow frequencies 6, 5, 4, 3 plus six singletons.
    expect(input.painPoints.longTail.themes).toBe(10)
    expect(input.painPoints.longTail.mentions).toBe(6 + 5 + 4 + 3 + 6)
    expect(input.painPoints.longTail.themesBySource).toEqual({ reddit: 4 + 3, hackernews: 4, rss: 3 })
  })

  it('[unhappy] a bucket of only frequency-1 themes yields no themes and a full long tail; all-empty input gives a zero sample', () => {
    const onlySingles = selectSynthesisInput({
      ...emptyBuckets(),
      emergingGaps: [
        theme({ theme: 'One', frequency: 1, sources: ['reddit'] }),
        theme({ theme: 'Two', frequency: 1, sources: ['hackernews'] }),
        theme({ theme: 'Three', frequency: 1, sources: ['reddit'] }),
      ],
    })
    expect(onlySingles.emergingGaps.themes).toEqual([])
    expect(onlySingles.emergingGaps.longTail.themes).toBe(3)
    expect(onlySingles.emergingGaps.longTail.mentions).toBe(3)
    expect(onlySingles.emergingGaps.longTail.themesBySource).toEqual({ reddit: 2, hackernews: 1 })

    const empty = selectSynthesisInput(emptyBuckets())
    for (const bucket of [empty.painPoints, empty.competitorWeaknesses, empty.emergingGaps]) {
      expect(bucket.themes).toEqual([])
      expect(bucket.longTail).toEqual({ themes: 0, mentions: 0, themesBySource: {} })
      expect(bucket.excludedPositive).toBe(0)
    }
    expect(empty.sample).toEqual({ analyzedItems: 0, sourceCounts: {}, basis: 'themes' })
  })

  it('[unhappy] limits quotes to 2 of at most 200 chars, caps names at 120, rounds sentiment, and drops urls', () => {
    const longName = 'N'.repeat(300)
    const withEvidence = theme({
      theme: longName,
      frequency: 4,
      sentiment: -0.4567,
      evidence: [
        { source: 'reddit', url: 'https://example.com/one', excerpt: 'Q'.repeat(500) },
        { source: 'reddit', url: 'https://example.com/two', excerpt: 'second quote' },
        { source: 'hackernews', url: 'https://example.com/three', excerpt: 'third quote' },
      ],
    })
    const named = { ...theme({ theme: 'raw cluster label', frequency: 3 }), synthesized_name: 'Friendly synthesized name' }

    const input = selectSynthesisInput({ ...emptyBuckets(), painPoints: [withEvidence, named] })

    const [first, second] = input.painPoints.themes
    expect(first?.quotes).toHaveLength(2)
    for (const quote of first?.quotes ?? []) {
      expect(quote.length).toBeLessThanOrEqual(200)
    }
    expect(first?.quotes[1]).toBe('second quote')
    expect(first?.name.length).toBeLessThanOrEqual(120)
    expect(first?.name.startsWith('NNNN')).toBe(true)
    expect(first?.sentiment).toBe(-0.46)
    expect(second?.name).toBe('Friendly synthesized name')

    const json = JSON.stringify(input)
    expect(json).not.toContain('url')
    expect(json).not.toContain('https://')
  })

  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] does not mutate or reorder the caller arrays and passes a given sample through with basis items', () => {
    const buckets = {
      painPoints: [
        theme({ theme: 'Low', frequency: 2 }),
        theme({ theme: 'High', frequency: 9 }),
        theme({ theme: 'Positive', frequency: 5, sentiment: 0.8 }),
        theme({ theme: 'Single', frequency: 1 }),
      ],
      competitorWeaknesses: [theme({ theme: 'Mid', frequency: 3 }), theme({ theme: 'Top', frequency: 7 })],
      emergingGaps: [theme({ theme: 'Gap small', frequency: 2 }), theme({ theme: 'Gap big', frequency: 6 })],
    }
    const before = structuredClone(buckets)

    const input = selectSynthesisInput(buckets, { analyzedItems: 12, sourceCounts: { reddit: 8, hackernews: 4 } })

    expect(buckets).toEqual(before)
    // The output itself is sorted, so the check above is meaningful.
    expect(input.painPoints.themes.map((t) => t.name)).toEqual(['High', 'Low'])
    expect(input.competitorWeaknesses.themes.map((t) => t.name)).toEqual(['Top', 'Mid'])
    expect(input.sample).toEqual({ analyzedItems: 12, sourceCounts: { reddit: 8, hackernews: 4 }, basis: 'items' })
  })

  it('[happy] each kept theme carries an id of bucket prefix plus its ORIGINAL index, even after filtering and re-sorting', () => {
    const buckets = {
      painPoints: [
        theme({ theme: 'Loved thing', frequency: 5, sentiment: 0.8 }),
        theme({ theme: 'Slow exports', frequency: 3 }),
      ],
      competitorWeaknesses: [theme({ theme: 'Mid', frequency: 3 }), theme({ theme: 'Top', frequency: 7 })],
      emergingGaps: [theme({ theme: 'Gap', frequency: 2 })],
    }
    const before = structuredClone(buckets)

    const input = selectSynthesisInput(buckets)

    // The positive theme at index 0 is dropped, so the kept theme keeps index 1.
    expect(input.painPoints.themes.map((t) => [t.name, t.id])).toEqual([['Slow exports', 'pp-1']])
    // Re-sorted by frequency: Top (original index 1) now precedes Mid (original index 0).
    expect(input.competitorWeaknesses.themes.map((t) => [t.name, t.id])).toEqual([
      ['Top', 'cw-1'],
      ['Mid', 'cw-0'],
    ])
    expect(input.emergingGaps.themes.map((t) => [t.name, t.id])).toEqual([['Gap', 'eg-0']])
    expect(buckets).toEqual(before)
  })
})

describe('findMissingSections', () => {
  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] does not count a prose mention of a section as its heading', () => {
    const report = [
      '## EXECUTIVE SUMMARY',
      'Users struggle with exports; see the recommendations below for next steps.',
      '## TOP PAIN POINTS',
      '- Slow exports',
      '## COMPETITOR WEAKNESSES',
      '- Weak plugins',
      '## EMERGING GAPS',
      '- None',
    ].join('\n')

    expect(findMissingSections(report)).toEqual(['RECOMMENDATIONS'])
  })

  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] accepts numbered, mixed-case and varied-depth heading lines', () => {
    const report = [
      '## EXECUTIVE SUMMARY',
      'text',
      '## 2. Top Pain Points',
      'text',
      '### competitor weaknesses',
      'text',
      '## Emerging Gaps',
      'text',
      '## RECOMMENDATIONS',
      'text',
    ].join('\n')

    expect(findMissingSections(report)).toEqual([])
  })
})
