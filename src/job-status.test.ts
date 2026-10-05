// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest'
import { toJobStatus } from './orchestrator.js'

describe('toJobStatus', () => {
  it('maps BullMQ active/completed/failed states directly', () => {
    expect(toJobStatus('active')).toBe('active')
    expect(toJobStatus('completed')).toBe('completed')
    expect(toJobStatus('failed')).toBe('failed')
  })

  it('maps all other BullMQ states to queued', () => {
    expect(toJobStatus('waiting')).toBe('queued')
    expect(toJobStatus('delayed')).toBe('queued')
    expect(toJobStatus('paused')).toBe('queued')
    expect(toJobStatus('prioritized')).toBe('queued')
    expect(toJobStatus('waiting-children')).toBe('queued')
    expect(toJobStatus('unknown')).toBe('queued')
  })
})
