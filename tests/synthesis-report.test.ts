import { describe, it, expect } from 'vitest'
import { parseSynthesisReply, renderReportMarkdown } from '../src/synthesis-report.js'
import { findMissingSections } from '../src/synthesis-input.js'

// Hand-built input mirroring a selectSynthesisInput() result, with ids that carry
// the caller's ORIGINAL bucket index (pp-1 is kept although pp-0 was dropped).
function makeInput() {
  return {
    sample: { analyzedItems: 12, sourceCounts: { reddit: 8, hackernews: 4 }, basis: 'items' as const },
    painPoints: {
      themes: [
        { id: 'pp-1', name: 'Slow exports', frequency: 4, sentiment: -0.6, sources: ['reddit'], quotes: ['exports take forever'] },
        { id: 'pp-3', name: 'Data loss on sync', frequency: 2, sentiment: -0.8, sources: ['hackernews'], quotes: [] },
      ],
      longTail: { themes: 0, mentions: 0, themesBySource: {} },
      excludedPositive: 1,
    },
    competitorWeaknesses: {
      themes: [{ id: 'cw-0', name: 'Weak plugins', frequency: 3, sentiment: -0.4, sources: ['reddit'], quotes: ['plugins are thin'] }],
      longTail: { themes: 0, mentions: 0, themesBySource: {} },
      excludedPositive: 0,
    },
    emergingGaps: {
      themes: [],
      longTail: { themes: 3, mentions: 3, themesBySource: { reddit: 3 } },
      excludedPositive: 0,
    },
  }
}

function reply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    executive_summary: 'Sample of 12 items from reddit and hackernews. Exports are the main complaint.',
    recommended_actions: [
      { action: 'Fix export speed', rationale: 'Most frequent complaint.', theme_ids: ['pp-1'] },
    ],
    ...overrides,
  })
}

describe('parseSynthesisReply', () => {
  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] non-JSON prose returns a parse error', () => {
    const result = parseSynthesisReply('## EXECUTIVE SUMMARY\nThis is prose, not JSON.', makeInput())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('parse')
  })

  it('[unhappy] valid JSON missing executive_summary returns a schema error', () => {
    const raw = JSON.stringify({
      recommended_actions: [{ action: 'Fix export speed', rationale: 'r', theme_ids: ['pp-1'] }],
    })

    const result = parseSynthesisReply(raw, makeInput())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('schema')
  })

  it('[unhappy] valid JSON with an empty recommended_actions array returns a schema error', () => {
    const result = parseSynthesisReply(reply({ recommended_actions: [] }), makeInput())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('schema')
  })

  it('[unhappy] drops an unknown cited id into droppedIds and keeps the resolvable one', () => {
    const raw = reply({
      recommended_actions: [{ action: 'Improve plugins', rationale: 'r', theme_ids: ['pp-99', 'cw-0'] }],
    })

    const result = parseSynthesisReply(raw, makeInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.droppedIds).toEqual(['pp-99'])
    expect(result.value.report.recommendedActions).toHaveLength(1)
    expect(result.value.report.recommendedActions[0]?.themes).toEqual([{ bucket: 'competitorWeaknesses', index: 0 }])
  })

  it('[unhappy] strips a ```json fence before parsing and maps snake_case to the camelCase report', () => {
    const fenced = '```json\n' + reply() + '\n```'

    const result = parseSynthesisReply(fenced, makeInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.droppedIds).toEqual([])
    expect(result.value.report).toEqual({
      executiveSummary: 'Sample of 12 items from reddit and hackernews. Exports are the main complaint.',
      recommendedActions: [
        {
          action: 'Fix export speed',
          rationale: 'Most frequent complaint.',
          themes: [{ bucket: 'painPoints', index: 1 }],
        },
      ],
    })
  })
})

describe('renderReportMarkdown', () => {
  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] renders five ## sections, a No recurring signal line for an empty bucket, and cited theme names', () => {
    const report = {
      executiveSummary: 'Sample of 12 items. Exports dominate.',
      recommendedActions: [
        {
          action: 'Fix export speed',
          rationale: 'Most frequent complaint.',
          themes: [
            { bucket: 'painPoints' as const, index: 1 },
            { bucket: 'competitorWeaknesses' as const, index: 0 },
          ],
        },
      ],
    }

    const markdown = renderReportMarkdown(report, makeInput())

    expect(findMissingSections(markdown)).toEqual([])
    expect(markdown.match(/^## /gm)).toHaveLength(5)
    expect(markdown).toContain('Sample of 12 items. Exports dominate.')
    expect(markdown).toContain('No recurring signal')

    const recommendations = markdown.slice(markdown.search(/^## .*RECOMMENDATIONS/im))
    expect(recommendations).toContain('Fix export speed')
    expect(recommendations).toContain('Most frequent complaint.')
    expect(recommendations).toContain('Slow exports')
    expect(recommendations).toContain('Weak plugins')
  })
})
