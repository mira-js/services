import { describe, it, expect } from 'vitest'
import { scrubInternalRefs } from '../src/synthesis-prose-guard.js'

describe('scrubInternalRefs', () => {
  // ─── unhappy ────────────────────────────────────────────────────────────────

  it('[unhappy] strips a parenthesised id with frequency and sentiment fragments', () => {
    const result = scrubInternalRefs('Rate limits are the top complaint (pp-0, frequency 7, sentiment -0.9).')

    expect(result).toEqual({ text: 'Rate limits are the top complaint.', removed: 1 })
  })

  it('[unhappy] strips bare ids and score-only parentheses, counting each match', () => {
    const result = scrubInternalRefs('Mod discovery is an emerging gap eg-1 (0.47) and setup friction eg-2 (-0.8) persists.')

    expect(result).toEqual({
      text: 'Mod discovery is an emerging gap and setup friction persists.',
      removed: 4,
    })
  })

  it('[unhappy] strips an inline id with trailing frequency and sentiment fragments', () => {
    const result = scrubInternalRefs('pp-0, frequency 7, sentiment -0.9 drives churn.')

    expect(result).toEqual({ text: 'drives churn.', removed: 1 })
  })

  it('[unhappy] leaves legitimate numbers untouched (over-strip guard)', () => {
    const input = 'Sample of 191 items (108 of 191 from Trustpilot and G2); pricing rose 40% ($500/month) in v2.1 (1).'

    const result = scrubInternalRefs(input)

    expect(result).toEqual({ text: input, removed: 0 })
  })

  // ─── happy ──────────────────────────────────────────────────────────────────

  it('[happy] returns text with no refs byte-identical, without normalising whitespace', () => {
    const result = scrubInternalRefs('Exports  are slow.')

    expect(result).toEqual({ text: 'Exports  are slow.', removed: 0 })
  })
})
