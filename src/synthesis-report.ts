// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import type { Result } from '@mira/shared-core'
import { stripFences } from './strip-fences.js'
import type { SynthesisBucket, SynthesisIdPrefix, SynthesisInput, SynthesisTheme } from './synthesis-input.js'

// ─── Types ────────────────────────────────────────────────────────────────────
// Mirrored in `@mira/shared`; the api assigns this shape to `ResearchResult.report`
// by structural typing alone, so a drift between the copies fails type-check.

export type ThemeBucket = 'painPoints' | 'competitorWeaknesses' | 'emergingGaps'

/** Points at `result[bucket][index]` in the caller's original theme arrays. */
export interface ThemeRef {
  bucket: ThemeBucket
  index: number
}

export interface RecommendedAction {
  action: string
  rationale: string
  themes: ThemeRef[]
}

export interface SynthesisReport {
  executiveSummary: string
  recommendedActions: RecommendedAction[]
}

export type SynthesisParseError = { kind: 'parse'; message: string } | { kind: 'schema'; message: string }

// ─── Reply schema (snake_case, as the prompt asks for it) ─────────────────────

const SynthesisReplySchema = z.object({
  executive_summary: z.string().trim().min(1).max(2000),
  recommended_actions: z
    .array(
      z.object({
        action: z.string().trim().min(1).max(300),
        rationale: z.string().trim().max(600),
        theme_ids: z.array(z.string()).max(6),
      }),
    )
    .min(1)
    .max(5),
})

// ─── Theme ids ────────────────────────────────────────────────────────────────

const BUCKET_BY_PREFIX: Record<SynthesisIdPrefix, ThemeBucket> = {
  pp: 'painPoints',
  cw: 'competitorWeaknesses',
  eg: 'emergingGaps',
}

const THEME_ID_PATTERN = /^(pp|cw|eg)-(0|[1-9]\d*)$/

function isIdPrefix(value: string): value is SynthesisIdPrefix {
  return value === 'pp' || value === 'cw' || value === 'eg'
}

/** `pp-3` → `{ bucket: 'painPoints', index: 3 }`; anything else → `null`. */
export function themeRefFromId(id: string): ThemeRef | null {
  const match = THEME_ID_PATTERN.exec(id.trim())
  const prefix = match?.[1]
  const index = match?.[2]
  if (prefix === undefined || index === undefined || !isIdPrefix(prefix)) return null
  return { bucket: BUCKET_BY_PREFIX[prefix], index: Number(index) }
}

function refKey(ref: ThemeRef): string {
  return `${ref.bucket}-${ref.index}`
}

function inputThemesByKey(input: SynthesisInput): Map<string, SynthesisTheme> {
  const entries = [...input.painPoints.themes, ...input.competitorWeaknesses.themes, ...input.emergingGaps.themes].flatMap(
    (theme): [string, SynthesisTheme][] => {
      const ref = themeRefFromId(theme.id)
      return ref ? [[refKey(ref), theme]] : []
    },
  )
  return new Map(entries)
}

// ─── Parse ────────────────────────────────────────────────────────────────────

function parseJson(text: string): Result<unknown, SynthesisParseError> {
  try {
    const value: unknown = JSON.parse(text)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: { kind: 'parse', message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Parse a structured synthesis reply into a `SynthesisReport`. Cited ids are
 * resolved against the ids present in `input`; an unknown id is dropped into
 * `droppedIds` rather than failing the parse. Pure.
 */
export function parseSynthesisReply(
  raw: string,
  input: SynthesisInput,
): Result<{ report: SynthesisReport; droppedIds: string[] }, SynthesisParseError> {
  const json = parseJson(stripFences(raw))
  if (!json.ok) return json

  const parsed = SynthesisReplySchema.safeParse(json.value)
  if (!parsed.success) return { ok: false, error: { kind: 'schema', message: parsed.error.message } }

  const known = inputThemesByKey(input)
  const droppedIds: string[] = []
  const recommendedActions = parsed.data.recommended_actions.map((entry): RecommendedAction => {
    const seen = new Set<string>()
    const themes = entry.theme_ids.flatMap((id): ThemeRef[] => {
      const ref = themeRefFromId(id)
      if (!ref || !known.has(refKey(ref))) {
        droppedIds.push(id)
        return []
      }
      if (seen.has(refKey(ref))) return []
      seen.add(refKey(ref))
      return [ref]
    })
    return { action: entry.action, rationale: entry.rationale, themes }
  })

  return {
    ok: true,
    value: { report: { executiveSummary: parsed.data.executive_summary, recommendedActions }, droppedIds },
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderTheme(theme: SynthesisTheme): string {
  const sources = theme.sources.length > 0 ? ` (${theme.sources.join(', ')})` : ''
  const mentions = `${theme.frequency} ${theme.frequency === 1 ? 'mention' : 'mentions'}`
  const quote = theme.quotes[0] ? ` — "${theme.quotes[0]}"` : ''
  return `- **${theme.name}** — ${mentions}${sources}${quote}`
}

function renderBucket(heading: string, bucket: SynthesisBucket): string {
  const body =
    bucket.themes.length > 0
      ? bucket.themes.map(renderTheme).join('\n')
      : `No recurring signal (${bucket.longTail.themes} long-tail ${bucket.longTail.themes === 1 ? 'theme' : 'themes'}).`
  return `## ${heading}\n\n${body}`
}

function renderAction(action: RecommendedAction, position: number, known: Map<string, SynthesisTheme>): string {
  const names = action.themes.flatMap((ref) => {
    const theme = known.get(refKey(ref))
    return theme ? [theme.name] : []
  })
  const rationale = action.rationale.length > 0 ? ` — ${action.rationale}` : ''
  const cited = names.length > 0 ? ` (themes: ${names.join(', ')})` : ''
  return `${position}. **${action.action}**${rationale}${cited}`
}

/**
 * The five-section markdown the prose path produces, built deterministically
 * from a structured report so export, copy and the CLI keep working. Pure.
 */
export function renderReportMarkdown(report: SynthesisReport, input: SynthesisInput): string {
  const known = inputThemesByKey(input)
  return [
    `## EXECUTIVE SUMMARY\n\n${report.executiveSummary}`,
    renderBucket('TOP PAIN POINTS', input.painPoints),
    renderBucket('COMPETITOR WEAKNESSES', input.competitorWeaknesses),
    renderBucket('EMERGING GAPS', input.emergingGaps),
    `## RECOMMENDATIONS\n\n${report.recommendedActions.map((a, i) => renderAction(a, i + 1, known)).join('\n')}`,
  ].join('\n\n')
}
