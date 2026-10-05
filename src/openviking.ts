// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import type { CollectedItem, OpenVikingFindOptions } from '@mira/shared-core'

const TempUploadResponseSchema = z.object({
  result: z.object({ temp_path: z.string() }),
})

const OPENVIKING_URL = process.env.OPENVIKING_URL || 'http://localhost:8080'
const OPENVIKING_API_KEY = process.env.OPENVIKING_API_KEY || ''

function authHeaders(): Record<string, string> {
  return OPENVIKING_API_KEY ? { 'x-api-key': OPENVIKING_API_KEY } : {}
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${OPENVIKING_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`OpenViking ${path} failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function tempUpload(content: string): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'text/plain' }), 'resource.md')
  const res = await fetch(`${OPENVIKING_URL}/api/v1/resources/temp_upload`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  if (!res.ok) {
    throw new Error(`OpenViking temp_upload failed: ${res.status} ${res.statusText}`)
  }
  const { result } = TempUploadResponseSchema.parse(await res.json())
  return result.temp_path
}

export const openVikingClient = {
  /**
   * Ingest a collected item into OpenViking's hierarchical resource store.
   * URI format: viking://resources/<source>/<subreddit|category>
   */
  async addResource(item: CollectedItem) {
    const segment = item.subreddit ?? item.category ?? 'general'
    const target = `viking://resources/${item.source}/${segment}`
    const content = `${item.title}\n\nURL: ${item.url}\nAuthor: ${item.author}\nTimestamp: ${item.timestamp}\n\n${item.body}`
    const tempPath = await tempUpload(content)
    return post('/api/v1/resources', {
      temp_path: tempPath,
      target,
      wait: true,
    })
  },

  /**
   * Semantic + structural search across all collected sources.
   */
  async find(query: string, options: Partial<OpenVikingFindOptions> = {}) {
    return post('/api/v1/search/find', {
      query,
      target_uri: options.scope ?? 'viking://resources/',
      limit: options.maxResults ?? 50,
    })
  },
}
