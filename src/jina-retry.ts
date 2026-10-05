// SPDX-License-Identifier: AGPL-3.0-only
import { logger } from '@mira/shared-core/logger'

// Jina embeddings 429 retry. Only rate-limit responses are retried; every other
// status and every network throw is a single attempt. Constants are hardcoded
// deliberately (not env-configurable) — see plan jina-embeddings-429-retry-backoff.

export const JINA_MAX_RETRIES = 3
export const JINA_BASE_DELAY_MS = 1_000
export const JINA_MAX_DELAY_MS = 20_000
export const JINA_TOTAL_WAIT_BUDGET_MS = 45_000

export type RetryDeps = {
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export const defaultRetryDeps: RetryDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}

const DELTA_SECONDS_PATTERN = /^\d+$/
// RFC 9110 IMF-fixdate, e.g. "Sun, 06 Nov 1994 08:49:37 GMT".
const IMF_FIXDATE_PATTERN = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/

// Parses a Retry-After header into milliseconds. Accepts only the two RFC 9110
// forms: delta-seconds (a non-negative integer) or an IMF-fixdate HTTP-date.
// Anything else ('1.5', '+5', '-1', free text) returns undefined so the caller
// falls back to exponential backoff; absent or empty headers do the same.
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined
  const value = header.trim()
  if (value === '') return undefined

  if (DELTA_SECONDS_PATTERN.test(value)) return Number(value) * 1000
  if (!IMF_FIXDATE_PATTERN.test(value)) return undefined

  const dateMs = Date.parse(value)
  if (Number.isNaN(dateMs)) return undefined
  return Math.max(0, dateMs - nowMs)
}

export async function fetchWithRetryOn429(
  doFetch: () => Promise<Response>,
  deps: RetryDeps = defaultRetryDeps
): Promise<Response> {
  let waitedMs = 0
  for (let retryIndex = 0; ; retryIndex++) {
    const res = await doFetch()
    if (res.status !== 429) return res
    if (retryIndex >= JINA_MAX_RETRIES) return res

    const delayMs =
      parseRetryAfter(res.headers.get('retry-after'), deps.now()) ??
      JINA_BASE_DELAY_MS * 2 ** retryIndex
    if (delayMs > JINA_MAX_DELAY_MS || waitedMs + delayMs > JINA_TOTAL_WAIT_BUDGET_MS) return res

    await res.body?.cancel()
    logger.warn('Jina embeddings rate-limited; retrying', {
      attempt: retryIndex + 1,
      delayMs,
      status: 429,
    })
    await deps.sleep(delayMs)
    waitedMs += delayMs
  }
}
