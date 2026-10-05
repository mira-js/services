// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CoreSource, type CollectedItem } from '@mira/shared-core'
import { openVikingClient } from './openviking'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function mockAddResource(tempPath = '/tmp/abc') {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ result: { temp_path: tempPath } }), { status: 200 }),
  )
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  )
}

function mockFind(body: unknown = { results: [] }) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200 }),
  )
}

function mockError(status = 500) {
  fetchMock.mockResolvedValueOnce(
    new Response('Internal Server Error', { status }),
  )
}

const redditItem: CollectedItem = {
  source: CoreSource.reddit,
  url: 'https://reddit.com/r/saas/comments/abc',
  title: 'Invoicing is broken',
  body: 'Every time I send an invoice it duplicates.',
  author: 'user123',
  timestamp: '2024-01-01T00:00:00Z',
  engagement: { upvotes: 42, comments: 7 },
  raw_replies: [],
  subreddit: 'saas',
}

describe('openVikingClient.addResource', () => {
  beforeEach(() => fetchMock.mockClear())

  it('uploads to temp_upload then posts to /api/v1/resources', async () => {
    mockAddResource()
    await openVikingClient.addResource(redditItem)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url1] = fetchMock.mock.calls[0]
    const [url2] = fetchMock.mock.calls[1]
    expect(String(url1)).toContain('/api/v1/resources/temp_upload')
    expect(String(url2)).toContain('/api/v1/resources')
  })

  it('builds target URI from source and subreddit', async () => {
    mockAddResource('/tmp/xyz')
    await openVikingClient.addResource(redditItem)
    const [, init] = fetchMock.mock.calls[1]
    const body = JSON.parse(init?.body as string)
    expect(body.target).toBe('viking://resources/reddit/saas')
    expect(body.temp_path).toBe('/tmp/xyz')
    expect(body.wait).toBe(true)
  })

  it('falls back to "general" when subreddit and category are absent', async () => {
    mockAddResource()
    await openVikingClient.addResource({ ...redditItem, subreddit: undefined })
    const [, init] = fetchMock.mock.calls[1]
    const body = JSON.parse(init?.body as string)
    expect(body.target).toBe('viking://resources/reddit/general')
  })

  it('uses source/category for news items', async () => {
    mockAddResource()
    await openVikingClient.addResource({
      ...redditItem,
      source: CoreSource.news,
      subreddit: undefined,
      category: 'Tech News',
    })
    const [, init] = fetchMock.mock.calls[1]
    const body = JSON.parse(init?.body as string)
    expect(body.target).toBe('viking://resources/news/Tech News')
  })

  it('throws on non-OK response from temp_upload', async () => {
    mockError(503)
    await expect(openVikingClient.addResource(redditItem)).rejects.toThrow('OpenViking')
  })
})

describe('openVikingClient.find', () => {
  beforeEach(() => fetchMock.mockClear())

  it('posts to /api/v1/search/find with defaults', async () => {
    mockFind()
    await openVikingClient.find('invoice pain points')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/v1/search/find')
    const body = JSON.parse(init?.body as string)
    expect(body.query).toBe('invoice pain points')
    expect(body.target_uri).toBe('viking://resources/')
    expect(body.limit).toBe(50)
  })

  it('merges caller-supplied options', async () => {
    mockFind()
    await openVikingClient.find('test', { maxResults: 10, scope: 'viking://resources/reddit/' })
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init?.body as string)
    expect(body.limit).toBe(10)
    expect(body.target_uri).toBe('viking://resources/reddit/')
  })

  it('throws on non-OK response', async () => {
    mockError(404)
    await expect(openVikingClient.find('test')).rejects.toThrow('OpenViking')
  })
})
