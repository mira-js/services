// SPDX-License-Identifier: AGPL-3.0-only
interface RedisConnectionOptions {
  host: string
  port: number
  maxRetriesPerRequest: null
}

export function redisConnection(): RedisConnectionOptions {
  const url = process.env.REDIS_URL || 'redis://localhost:6379'
  const parsed = new URL(url)
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    maxRetriesPerRequest: null,
  }
}
