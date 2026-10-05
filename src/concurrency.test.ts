// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest'
import { mapWithConcurrency } from './concurrency.js'

describe('mapWithConcurrency', () => {
  it('preserves input order', async () => {
    const result = await mapWithConcurrency([3, 1, 2], 2, async (n) => n * 2)
    expect(result).toEqual([6, 2, 4])
  })

  it('handles empty array', async () => {
    const result = await mapWithConcurrency([], 3, async (x) => x)
    expect(result).toEqual([])
  })

  it('respects concurrency limit', async () => {
    let running = 0
    let maxRunning = 0
    const concurrency = 2
    const items = [1, 2, 3, 4, 5]
    await mapWithConcurrency(items, concurrency, async (item) => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise(r => setTimeout(r, 10))
      running--
      return item * 2
    })
    expect(maxRunning).toBeLessThanOrEqual(concurrency)
  })

  it('propagates rejected promise', async () => {
    const items = [1, 2, 3]
    await expect(mapWithConcurrency(items, 2, async (item) => {
      if (item === 2) throw new Error('fail')
      return item
    })).rejects.toThrow('fail')
  })
})
