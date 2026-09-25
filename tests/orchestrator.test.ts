import { beforeEach, describe, expect, it, vi } from 'vitest'

const queueAdd = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'job-1' }))

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: queueAdd,
    getJob: vi.fn(),
    getJobs: vi.fn(),
  })),
  Worker: vi.fn(),
}))

import { orchestrator } from '../src/orchestrator'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('orchestrator.enqueue — fix round', () => {
  it('[happy] forwards opts.jobId to queue.add opts alongside attempts: 3', async () => {
    await orchestrator.enqueue({ query: 'pricing complaints' } as never, { jobId: 'fixed-job-id' })

    expect(queueAdd).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ jobId: 'fixed-job-id', attempts: 3 }),
    )
  })
})
