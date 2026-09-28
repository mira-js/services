import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fetchWithRetryOn429,
  parseRetryAfter,
  type RetryDeps,
} from '../src/jina-retry.js'

const NOW = 1_700_000_000_000

function makeDeps(): RetryDeps {
  return {
    sleep: vi.fn(async () => {}),
    now: () => NOW,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('jina-retry', () => {
  it('[unhappy] fetchWithRetryOn429 — 429 x4 with no Retry-After header returns the 4th 429, calling doFetch 4 times and sleeping 1000, 2000, 4000', async () => {
    const responses = Array.from(
      { length: 4 },
      () => new Response('body', { status: 429, statusText: 'Too Many Requests' }),
    )
    const doFetch = vi.fn()
    responses.forEach((r) => doFetch.mockResolvedValueOnce(r))
    const deps = makeDeps()

    const result = await fetchWithRetryOn429(doFetch, deps)

    expect(result).toBe(responses[3])
    expect(doFetch).toHaveBeenCalledTimes(4)
    expect(deps.sleep).toHaveBeenCalledTimes(3)
    expect(vi.mocked(deps.sleep).mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000])
  })

  it('[unhappy] fetchWithRetryOn429 — 429 with Retry-After: 60 returns immediately, doFetch called once, sleep never called (above the 20s cap)', async () => {
    const response = new Response('body', { status: 429, headers: { 'retry-after': '60' } })
    const doFetch = vi.fn().mockResolvedValue(response)
    const deps = makeDeps()

    const result = await fetchWithRetryOn429(doFetch, deps)

    expect(result).toBe(response)
    expect(doFetch).toHaveBeenCalledTimes(1)
    expect(deps.sleep).not.toHaveBeenCalled()
  })

  it('[unhappy] fetchWithRetryOn429 — three 429s with Retry-After: 20 sleeps 20000 twice then gives up (third wait would exceed the 45s budget), doFetch called 3 times', async () => {
    const responses = Array.from(
      { length: 3 },
      () => new Response('body', { status: 429, headers: { 'retry-after': '20' } }),
    )
    const doFetch = vi.fn()
    responses.forEach((r) => doFetch.mockResolvedValueOnce(r))
    const deps = makeDeps()

    const result = await fetchWithRetryOn429(doFetch, deps)

    expect(result).toBe(responses[2])
    expect(doFetch).toHaveBeenCalledTimes(3)
    expect(vi.mocked(deps.sleep).mock.calls.map((c) => c[0])).toEqual([20000, 20000])
  })

  it('[unhappy] fetchWithRetryOn429 — a 503 is returned as-is, doFetch called once, no sleep', async () => {
    const response = new Response('body', { status: 503 })
    const doFetch = vi.fn().mockResolvedValue(response)
    const deps = makeDeps()

    const result = await fetchWithRetryOn429(doFetch, deps)

    expect(result).toBe(response)
    expect(doFetch).toHaveBeenCalledTimes(1)
    expect(deps.sleep).not.toHaveBeenCalled()
  })

  it('[unhappy] fetchWithRetryOn429 — a rejected doFetch propagates the rejection, not retried, doFetch called once', async () => {
    const error = new Error('network down')
    const doFetch = vi.fn().mockRejectedValue(error)
    const deps = makeDeps()

    await expect(fetchWithRetryOn429(doFetch, deps)).rejects.toThrow('network down')
    expect(doFetch).toHaveBeenCalledTimes(1)
  })

  it('[unhappy] parseRetryAfter — null, empty, non-numeric, and negative strings return undefined; a past HTTP-date returns 0', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined()
    expect(parseRetryAfter('', NOW)).toBeUndefined()
    expect(parseRetryAfter('abc', NOW)).toBeUndefined()
    expect(parseRetryAfter('-5', NOW)).toBeUndefined()
    const pastDate = new Date(NOW - 10_000).toUTCString()
    expect(parseRetryAfter(pastDate, NOW)).toBe(0)
  })

  it('[unhappy] parseRetryAfter — non-RFC delta-seconds like "1.5" and "+5" return undefined, not a lenient Date.parse result', () => {
    expect(parseRetryAfter('1.5', NOW)).toBeUndefined()
    expect(parseRetryAfter('+5', NOW)).toBeUndefined()
  })

  it('[unhappy] fetchWithRetryOn429 — 429 with Retry-After: 1.5, then 200 falls back to exponential backoff; sleep called once with 1000', async () => {
    const retryResponse = new Response('body', { status: 429, headers: { 'retry-after': '1.5' } })
    const okResponse = new Response('ok', { status: 200 })
    const doFetch = vi.fn().mockResolvedValueOnce(retryResponse).mockResolvedValueOnce(okResponse)
    const deps = makeDeps()

    const result = await fetchWithRetryOn429(doFetch, deps)

    expect(result).toBe(okResponse)
    expect(doFetch).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenCalledTimes(1)
    expect(deps.sleep).toHaveBeenCalledWith(1000)
  })

  it('[happy] fetchWithRetryOn429 — 429 (Retry-After: 2), then 200 returns the 200; sleep called once with 2000', async () => {
    const retryResponse = new Response('body', { status: 429, headers: { 'retry-after': '2' } })
    const okResponse = new Response('ok', { status: 200 })
    const doFetch = vi.fn().mockResolvedValueOnce(retryResponse).mockResolvedValueOnce(okResponse)
    const deps = makeDeps()

    const result = await fetchWithRetryOn429(doFetch, deps)

    expect(result).toBe(okResponse)
    expect(doFetch).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenCalledTimes(1)
    expect(deps.sleep).toHaveBeenCalledWith(2000)
  })

  it('[happy] parseRetryAfter — "5" -> 5000, "0" -> 0, an HTTP-date 3s after the injected now -> 3000', () => {
    expect(parseRetryAfter('5', NOW)).toBe(5000)
    expect(parseRetryAfter('0', NOW)).toBe(0)
    const futureDate = new Date(NOW + 3000).toUTCString()
    expect(parseRetryAfter(futureDate, NOW)).toBe(3000)
  })
})
