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

function singleMention(id: string, name: string) {
  return { id, name, frequency: 1, sentiment: -0.5, sources: ['reddit'], quotes: ['only said once'] }
}

// Extracts one rendered section (heading line up to the next ## heading).
function section(markdown: string, heading: RegExp): string {
  const start = markdown.search(heading)
  const rest = markdown.slice(start)
  const next = rest.slice(2).search(/^## /m)
  return next === -1 ? rest : rest.slice(0, next + 2)
}

const emptyReport = {
  executiveSummary: 'Sample of 12 items. Nothing recurs.',
  recommendedActions: [{ action: 'Broaden the query', rationale: 'Nothing recurs.', themes: [] }],
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
  it('[unhappy] scrubs theme ids and score fragments from the summary and rationale while theme_ids still resolve', () => {
    const raw = reply({
      executive_summary: 'Sample of 12 items. Exports dominate (pp-1, frequency 4, sentiment -0.6).',
      recommended_actions: [
        { action: 'Fix export speed', rationale: 'Most frequent complaint pp-1 (-0.6).', theme_ids: ['pp-1'] },
      ],
    })

    const result = parseSynthesisReply(raw, makeInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.report.executiveSummary).toBe('Sample of 12 items. Exports dominate.')
    expect(result.value.report.recommendedActions[0]?.rationale).toBe('Most frequent complaint.')
    expect(result.value.report.recommendedActions[0]?.themes).toEqual([{ bucket: 'painPoints', index: 1 }])
    expect(result.value.scrubbedRefs).toBe(3)
    expect(result.value.droppedIds).toEqual([])
  })

  it('[unhappy] a cited single-mention id resolves to its bucket and original index with no dropped ids', () => {
    const base = makeInput()
    const input = {
      ...base,
      painPoints: { ...base.painPoints, singleMentions: [singleMention('pp-4', 'Awkward share flow')] },
    }
    const raw = reply({
      recommended_actions: [{ action: 'Validate share flow', rationale: 'Came up once.', theme_ids: ['pp-4'] }],
    })

    const result = parseSynthesisReply(raw, input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.droppedIds).toEqual([])
    expect(result.value.report.recommendedActions[0]?.themes).toEqual([{ bucket: 'painPoints', index: 4 }])
  })

  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] a clean reply reports scrubbedRefs 0 and an unchanged report', () => {
    const result = parseSynthesisReply(reply(), makeInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.scrubbedRefs).toBe(0)
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
  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] an empty bucket without singleMentions renders "mentioned once" wording and never "long-tail"', () => {
    const markdown = renderReportMarkdown(emptyReport, makeInput())

    const gaps = section(markdown, /^## .*EMERGING GAPS/im)
    expect(gaps).toContain('No recurring signal (3 topics mentioned once).')
    expect(markdown).not.toContain('long-tail')
    expect(markdown).not.toMatch(/long[- ]tail/i)
    expect(markdown.match(/^## /gm)).toHaveLength(5)
  })

  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] painPoints singleMentions render a label line and one bullet each, keeping five ## headings', () => {
    const input = {
      ...makeInput(),
      painPoints: {
        themes: [],
        singleMentions: [singleMention('pp-4', 'Awkward share flow'), singleMention('pp-7', 'Lost saved designs')],
        longTail: { themes: 16, mentions: 16, themesBySource: { reddit: 16 } },
        excludedPositive: 5,
      },
    }

    const markdown = renderReportMarkdown(emptyReport, input)

    const pain = section(markdown, /^## .*TOP PAIN POINTS/im)
    expect(pain).toContain('**Single mentions, not yet a pattern** (top 2 of 16 mentioned once):')
    expect(pain).toContain('- **Awkward share flow**')
    expect(pain).toContain('- **Lost saved designs**')
    expect(pain).not.toContain('No recurring signal')
    expect(markdown.match(/^## /gm)).toHaveLength(5)
    expect(findMissingSections(markdown)).toEqual([])
    expect(markdown).not.toMatch(/long[- ]tail/i)
  })

  it('[happy] emergingGaps singleMentions with K equal to N omit "top"', () => {
    const input = {
      ...makeInput(),
      emergingGaps: {
        themes: [],
        singleMentions: [singleMention('eg-2', 'Wants a public gallery')],
        longTail: { themes: 1, mentions: 1, themesBySource: { reddit: 1 } },
        excludedPositive: 3,
      },
    }

    const markdown = renderReportMarkdown(emptyReport, input)

    const gaps = section(markdown, /^## .*EMERGING GAPS/im)
    expect(gaps).toContain('**Single mentions, not yet a pattern** (1 mentioned once):')
    expect(gaps).not.toContain('(top')
    expect(gaps).toContain('- **Wants a public gallery**')
  })

  it('[happy] an action citing a single-mention ref lists its name under (themes: ...)', () => {
    const base = makeInput()
    const input = {
      ...base,
      painPoints: { ...base.painPoints, singleMentions: [singleMention('pp-4', 'Awkward share flow')] },
    }
    const report = {
      executiveSummary: 'Sample of 12 items.',
      recommendedActions: [
        {
          action: 'Validate the share flow',
          rationale: 'Came up once.',
          themes: [{ bucket: 'painPoints' as const, index: 4 }],
        },
      ],
    }

    const markdown = renderReportMarkdown(report, input)

    const recommendations = section(markdown, /^## .*RECOMMENDATIONS/im)
    expect(recommendations).toContain('Validate the share flow')
    expect(recommendations).toMatch(/\(themes: [^)]*Awkward share flow/)
  })

  it('[happy] the five-section render with an empty bucket still contains No recurring signal (expect: green)', () => {
    const markdown = renderReportMarkdown(emptyReport, makeInput())

    expect(markdown.match(/^## /gm)).toHaveLength(5)
    expect(markdown).toContain('No recurring signal')
  })

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
