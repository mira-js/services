import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { debugRawEnabled } from '../src/debug.js'

describe('debugRawEnabled', () => {
  const originalValue = process.env.MIRA_DEBUG_LLM_RAW

  beforeEach(() => {
    delete process.env.MIRA_DEBUG_LLM_RAW
  })

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.MIRA_DEBUG_LLM_RAW
    } else {
      process.env.MIRA_DEBUG_LLM_RAW = originalValue
    }
  })

  it('[happy] returns true when MIRA_DEBUG_LLM_RAW is "1"', () => {
    process.env.MIRA_DEBUG_LLM_RAW = '1'
    expect(debugRawEnabled()).toBe(true)
  })

  it('[happy] returns false when MIRA_DEBUG_LLM_RAW is "true"', () => {
    process.env.MIRA_DEBUG_LLM_RAW = 'true'
    expect(debugRawEnabled()).toBe(false)
  })

  it('[happy] returns false when MIRA_DEBUG_LLM_RAW is unset, then true once set (read per call)', () => {
    delete process.env.MIRA_DEBUG_LLM_RAW
    expect(debugRawEnabled()).toBe(false)
    process.env.MIRA_DEBUG_LLM_RAW = '1'
    expect(debugRawEnabled()).toBe(true)
  })
})
