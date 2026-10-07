// SPDX-License-Identifier: AGPL-3.0-only
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import type { JobStatus, ResearchJobInput, ResearchResult } from '@mira/shared-core'

// Queue-request client only. Workers keep `redisConnection()` (maxRetriesPerRequest: null,
// which BullMQ Workers require). A finite retry count lets commands fail instead of
// queueing forever while Redis is down.
const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
})

const researchQueue = new Queue<ResearchJobInput, ResearchResult>('research', { connection })

const DEFAULT_QUEUE_TIMEOUT_MS = 5000

// Read at call time so tests and operators can change it without a restart.
const queueTimeoutMs = (): number => Number(process.env.MIRA_QUEUE_TIMEOUT_MS) || DEFAULT_QUEUE_TIMEOUT_MS

// BullMQ's Queue waits for connection readiness, so ioredis options alone do not
// fail fast; this bounds every queue call so callers get a clear rejection.
async function withTimeout<T>(run: () => Promise<T>): Promise<T> {
  const ms = queueTimeoutMs()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Queue unavailable: Redis did not respond within ${ms} ms`)),
      ms,
    )
  })
  try {
    return await Promise.race([run(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function toJobStatus(state: string): JobStatus {
  switch (state) {
    case 'active': return 'active'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    default: return 'queued'
  }
}

export const orchestrator = {
  // `opts.jobId` lets the caller pick the job id up front (e.g. to write its own
  // history row before the job can start). Omitting it keeps BullMQ's counter id.
  //
  // Rejects without calling Queue.add unless Redis is ready: a timed-out add is not
  // cancelled, so letting it through could land a job the caller already reported failed.
  async enqueue(input: ResearchJobInput, opts: { jobId?: string } = {}): Promise<{ id: string }> {
    if (connection.status !== 'ready') {
      throw new Error(`Queue unavailable: Redis connection is ${connection.status}`)
    }
    return withTimeout(async () => {
      const job = await researchQueue.add('research', input, {
        ...(opts.jobId ? { jobId: opts.jobId } : {}),
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      })
      if (!job.id) throw new Error('BullMQ returned a job without an ID')
      return { id: job.id }
    })
  },

  async getJob(jobId: string) {
    return withTimeout(async () => {
      const job = await researchQueue.getJob(jobId)
      if (!job) return null

      return {
        jobId: String(job.id),
        status: toJobStatus(await job.getState()),
        query: job.data.query,
        sources: job.data.sources,
        depth: job.data.depth,
        createdAt: new Date(job.timestamp).toISOString(),
        progress: job.progress ?? undefined,
        result: job.returnvalue ?? undefined,
      }
    })
  },

  async listJobs() {
    return withTimeout(async () => {
      const jobs = await researchQueue.getJobs(['active', 'waiting', 'delayed', 'completed', 'failed'])
      return Promise.all(
        jobs.map(async (job) => ({
          jobId: String(job.id),
          query: job.data.query,
          status: toJobStatus(await job.getState()),
        })),
      )
    })
  },
}
