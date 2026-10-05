// SPDX-License-Identifier: AGPL-3.0-only
import { Pool } from 'pg'
import type { Result } from '@mira/shared-core'

let pool: Pool | null = null

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set')
    }
    pool = new Pool({ connectionString })
  }
  return pool
}

export async function query<T extends object>(
  text: string,
  params?: unknown[],
): Promise<Result<T[]>> {
  try {
    const result = await getPool().query<T>(text, params)
    return { ok: true, value: result.rows }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }
}

export function closePool(): Promise<void> {
  if (!pool) return Promise.resolve()
  const p = pool
  pool = null
  return p.end()
}
