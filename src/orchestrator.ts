import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import type { JobStatus, ResearchJobInput, ResearchResult } from '@mira/shared-core'

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
})

const researchQueue = new Queue<ResearchJobInput, ResearchResult>('research', { connection })

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
  async enqueue(input: ResearchJobInput, opts: { jobId?: string } = {}) {
    const job = await researchQueue.add('research', input, {
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    })
    if (!job.id) throw new Error('BullMQ returned a job without an ID')
    return { id: job.id }
  },

  async getJob(jobId: string) {
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
  },

  async listJobs() {
    const jobs = await researchQueue.getJobs(['active', 'waiting', 'delayed', 'completed', 'failed'])
    return Promise.all(
      jobs.map(async (job) => ({
        jobId: String(job.id),
        query: job.data.query,
        status: toJobStatus(await job.getState()),
      })),
    )
  },
}
