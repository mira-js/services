// SPDX-License-Identifier: AGPL-3.0-only
import type { PainPointTheme } from '@mira/shared-core'

export const SYNTHESIS_MIN_FREQUENCY = 2
export const SYNTHESIS_MAX_THEMES_PER_BUCKET = 10
export const SYNTHESIS_MAX_QUOTES_PER_THEME = 2
export const SYNTHESIS_MAX_QUOTE_CHARS = 200
export const SYNTHESIS_MAX_NAME_CHARS = 120
export const SYNTHESIS_SECTIONS = ['EXECUTIVE SUMMARY', 'TOP PAIN POINTS', 'COMPETITOR WEAKNESSES', 'EMERGING GAPS', 'RECOMMENDATIONS'] as const

export type ThemeBuckets = {
  painPoints: PainPointTheme[]
  competitorWeaknesses: PainPointTheme[]
  emergingGaps: PainPointTheme[]
}

export type SynthesisSample = { analyzedItems: number; sourceCounts: Record<string, number> }

export type SynthesisTheme = {
  name: string
  frequency: number
  sentiment: number
  sources: string[]
  quotes: string[]
}

export type SynthesisBucket = {
  themes: SynthesisTheme[]
  longTail: { themes: number; mentions: number; themesBySource: Record<string, number> }
  excludedPositive: number
}

export type SynthesisInput = {
  sample: SynthesisSample & { basis: 'items' | 'themes' }
  painPoints: SynthesisBucket
  competitorWeaknesses: SynthesisBucket
  emergingGaps: SynthesisBucket
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function themeName(t: PainPointTheme): string {
  const name = 'synthesized_name' in t && typeof t.synthesized_name === 'string' && t.synthesized_name.length > 0 ? t.synthesized_name : t.theme
  return truncate(name, SYNTHESIS_MAX_NAME_CHARS)
}

function themeQuotes(t: PainPointTheme): string[] {
  const quotes = t.evidence
    .slice(0, SYNTHESIS_MAX_QUOTES_PER_THEME)
    .map((e) => truncate(e.excerpt, SYNTHESIS_MAX_QUOTE_CHARS))
    .filter((q) => q.length > 0)
  return [...new Set(quotes)]
}

function toSynthesisTheme(t: PainPointTheme): SynthesisTheme {
  return {
    name: themeName(t),
    frequency: t.frequency,
    sentiment: Math.round(t.sentiment * 100) / 100,
    sources: [...t.sources],
    quotes: themeQuotes(t),
  }
}

function countBySource(themes: PainPointTheme[]): Record<string, number> {
  return themes.reduce<Record<string, number>>((acc, t) => {
    for (const source of new Set(t.sources)) acc[source] = (acc[source] ?? 0) + 1
    return acc
  }, {})
}

function selectBucket(themes: PainPointTheme[], dropPositive: boolean): SynthesisBucket {
  const positive = dropPositive ? themes.filter((t) => t.sentiment > 0) : []
  const candidates = dropPositive ? themes.filter((t) => t.sentiment <= 0) : themes
  const recurring = candidates.filter((t) => t.frequency >= SYNTHESIS_MIN_FREQUENCY).sort((a, b) => b.frequency - a.frequency)
  const kept = recurring.slice(0, SYNTHESIS_MAX_THEMES_PER_BUCKET)
  const tail = [...recurring.slice(SYNTHESIS_MAX_THEMES_PER_BUCKET), ...candidates.filter((t) => t.frequency < SYNTHESIS_MIN_FREQUENCY)]
  return {
    themes: kept.map(toSynthesisTheme),
    longTail: {
      themes: tail.length,
      mentions: tail.reduce((sum, t) => sum + t.frequency, 0),
      themesBySource: countBySource(tail),
    },
    excludedPositive: positive.length,
  }
}

function fallbackSample(buckets: ThemeBuckets): SynthesisSample {
  const all = [...buckets.painPoints, ...buckets.competitorWeaknesses, ...buckets.emergingGaps]
  return {
    analyzedItems: all.reduce((sum, t) => sum + t.frequency, 0),
    sourceCounts: countBySource(all),
  }
}

/**
 * Reduce the aggregated theme buckets to the compact evidence the synthesis
 * prompt needs. Pure: the caller's arrays are never mutated or reordered.
 */
export function selectSynthesisInput(buckets: ThemeBuckets, sample?: SynthesisSample): SynthesisInput {
  return {
    sample: sample
      ? { analyzedItems: sample.analyzedItems, sourceCounts: sample.sourceCounts, basis: 'items' }
      : { ...fallbackSample(buckets), basis: 'themes' },
    painPoints: selectBucket(buckets.painPoints, true),
    competitorWeaknesses: selectBucket(buckets.competitorWeaknesses, false),
    emergingGaps: selectBucket(buckets.emergingGaps, false),
  }
}

function headingPattern(section: string): RegExp {
  const name = section.split(' ').join('[ \\t]+')
  return new RegExp(`^#{1,6}[ \\t]*(\\d+[.)][ \\t]*)?${name}\\b`, 'im')
}

/** Section names with no heading line in the report; prose mentions do not count. */
export function findMissingSections(report: string): string[] {
  return SYNTHESIS_SECTIONS.filter((section) => !headingPattern(section).test(report))
}
