// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest'

describe('redisConnection', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL
  })

  it('parses REDIS_URL into host and port', async () => {
    process.env.REDIS_URL = 'redis://localhost:6380'
    const { redisConnection } = await import('./redis.js')
    const opts = redisConnection()
    expect(opts.host).toBe('localhost')
    expect(opts.port).toBe(6380)
  })

  it('defaults port to 6379 when URL has no explicit port', async () => {
    process.env.REDIS_URL = 'redis://myhost'
    const { redisConnection } = await import('./redis.js')
    const opts = redisConnection()
    expect(opts.port).toBe(6379)
  })

  it('sets maxRetriesPerRequest to null', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379'
    const { redisConnection } = await import('./redis.js')
    const opts = redisConnection()
    expect(opts.maxRetriesPerRequest).toBeNull()
  })
})
