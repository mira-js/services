import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queueAdd: vi.fn(),
  queueGetJob: vi.fn(),
  queueGetJobs: vi.fn(),
  redisInstance: { status: 'ready', on: vi.fn() },
  redisCtorCalls: [] as unknown[][],
}))

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mocks.queueAdd,
    getJob: mocks.queueGetJob,
    getJobs: mocks.queueGetJobs,
  })),
  Worker: vi.fn(),
}))

vi.mock('ioredis', () => {
  const Redis = vi.fn().mockImplementation((...args: unknown[]) => {
    mocks.redisCtorCalls.push(args)
    return mocks.redisInstance
  })
  return { Redis, default: Redis }
})

import { orchestrator } from '../src/orchestrator'

const neverSettles = (): Promise<never> => new Promise<never>(() => {})
const input = { query: 'pricing complaints' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.redisInstance.status = 'ready'
  process.env.MIRA_QUEUE_TIMEOUT_MS = '50'
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.MIRA_QUEUE_TIMEOUT_MS
})

describe('orchestrator fail-fast — unhappy', () => {
  it('[unhappy] enqueue rejects with Queue unavailable and never calls Queue.add when Redis is not ready', async () => {
    mocks.redisInstance.status = 'reconnecting'
    mocks.queueAdd.mockResolvedValue({ id: 'job-1' })

    await expect(orchestrator.enqueue(input)).rejects.toThrow(/Queue unavailable/)

    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it('[unhappy] enqueue rejects with Queue unavailable within 1s when Queue.add never settles', async () => {
    mocks.queueAdd.mockReturnValue(neverSettles())
    const started = Date.now()

    const rejection = await orchestrator.enqueue(input).then(
      () => null,
      (error: unknown) => error,
    )

    expect(rejection).toBeInstanceOf(Error)
    if (!(rejection instanceof Error)) return
    expect(rejection.message).toContain('Queue unavailable')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('[unhappy] getJob rejects with Queue unavailable within 1s when Queue.getJob never settles', async () => {
    mocks.queueGetJob.mockReturnValue(neverSettles())
    const started = Date.now()

    await expect(orchestrator.getJob('job-1')).rejects.toThrow(/Queue unavailable/)

    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('[unhappy] listJobs rejects with Queue unavailable within 1s when Queue.getJobs never settles', async () => {
    mocks.queueGetJobs.mockReturnValue(neverSettles())
    const started = Date.now()

    await expect(orchestrator.listJobs()).rejects.toThrow(/Queue unavailable/)

    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('orchestrator fail-fast — happy', () => {
  it('[happy] constructs the ioredis client with a finite maxRetriesPerRequest (not null)', () => {
    expect(mocks.redisCtorCalls.length).toBeGreaterThan(0)
    const options = mocks.redisCtorCalls[0]?.[1]

    expect(options).toEqual(expect.objectContaining({ maxRetriesPerRequest: expect.any(Number) }))
    if (typeof options !== 'object' || options === null || !('maxRetriesPerRequest' in options)) return
    expect(Number.isFinite(options.maxRetriesPerRequest)).toBe(true)
  })

  it('[happy] enqueue resolves the job id and leaves no pending timer (expect: green)', async () => {
    vi.useFakeTimers()
    mocks.queueAdd.mockResolvedValue({ id: 'job-1' })

    await expect(orchestrator.enqueue(input)).resolves.toEqual({ id: 'job-1' })

    expect(vi.getTimerCount()).toBe(0)
  })
})
