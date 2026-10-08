// SPDX-License-Identifier: AGPL-3.0-only

// A fragment the model leaks into prose: a theme id, a labelled frequency/sentiment
// number, or a bare decimal score. Used only inside parentheses (pass 1).
const FRAG = String.raw`(?:(?:pp|cw|eg)-\d+|(?:frequency|sentiment)\s*:?\s*[-+]?\d+(?:\.\d+)?|[-+]?\d*\.\d+)`

// Pass 1: a parenthesised group made only of fragments, with its leading blanks.
const PAREN_FRAGMENTS = new RegExp(String.raw`[ \t]*\(\s*${FRAG}(?:\s*[,;]\s*${FRAG})*\s*\)`, 'gi')

// Pass 2: a bare theme id and any `, frequency N, sentiment X` tail.
const BARE_ID = new RegExp(
  String.raw`\b(?:pp|cw|eg)-\d+\b(?:\s*[,;]\s*(?:frequency|sentiment)\s*:?\s*[-+]?\d+(?:\.\d+)?)*`,
  'gi',
)

function stripAll(text: string, pattern: RegExp): { text: string; removed: number } {
  let removed = 0
  const stripped = text.replace(pattern, () => {
    removed += 1
    return ''
  })
  return { text: stripped, removed }
}

function tidy(text: string): string {
  return text
    .replace(/\(\s*\)/g, '')
    .replace(/,\s*(?=[,.;:!?)])/g, '')
    .replace(/[ \t]+(?=[,.;:!?)])/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * Remove internal theme ids (`pp|cw|eg-N`), labelled frequency/sentiment numbers
 * and score-only parentheses from model prose. Text with no match is returned
 * byte-identical. Pure and total.
 */
export function scrubInternalRefs(text: string): { text: string; removed: number } {
  const first = stripAll(text, PAREN_FRAGMENTS)
  const second = stripAll(first.text, BARE_ID)
  const removed = first.removed + second.removed
  if (removed === 0) return { text, removed: 0 }
  return { text: tidy(second.text), removed }
}
