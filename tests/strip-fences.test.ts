import { describe, it, expect } from 'vitest'
import { stripFences } from '../src/analysis.js'

describe('stripFences', () => {
  // ─── unhappy ──────────────────────────────────────────────────────────────

  it('[unhappy] returns trimmed text when there are no brackets at all', () => {
    expect(stripFences('notjson')).toBe('notjson')
  })

  it('[unhappy] returns trimmed text when an opening brace has no matching close', () => {
    expect(stripFences('  not json {{ secret  ')).toBe('not json {{ secret')
  })

  it('[unhappy] strips a fenced block preceded by prose', () => {
    const raw = 'Here is the JSON:\n```json\n[{"a":1}]\n```'
    expect(stripFences(raw)).toBe('[{"a":1}]')
  })

  it('[unhappy] strips a fence surrounded by leading/trailing newlines', () => {
    const raw = '\n```json\n[1,2]\n```\n'
    expect(stripFences(raw)).toBe('[1,2]')
  })

  it('[unhappy] drops trailing prose after a bracket span', () => {
    const raw = '[1,2]\n\nLet me know if…'
    expect(stripFences(raw)).toBe('[1,2]')
  })

  it('[unhappy] returns the object root, not an inner array, when the object contains an array', () => {
    const raw = '```json\n{"results":[{"a":1}]}\n```\nLet me know if you need anything else.'
    expect(stripFences(raw)).toBe('{"results":[{"a":1}]}')
  })

  // ─── happy ────────────────────────────────────────────────────────────────

  it('[happy] leaves a plain JSON array unchanged', () => {
    expect(stripFences('[1,2,3]')).toBe('[1,2,3]')
  })

  it('[happy] leaves a plain JSON object unchanged', () => {
    expect(stripFences('{"a":1}')).toBe('{"a":1}')
  })

  it('[happy] strips a classic ```json fenced array', () => {
    const raw = '```json\n[{"a":1}]\n```'
    expect(stripFences(raw)).toBe('[{"a":1}]')
  })
})
