// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** `MIRA_PROMPTS_DIR`, else the host repo's `prompts/` (read once at module load). */
export const PROMPTS_DIR = process.env.MIRA_PROMPTS_DIR ?? join(MODULE_DIR, '../../../../prompts')

/**
 * The prompts shipped with mira-core itself (`mira-core/prompts`). The same
 * relative path resolves from both `src/` and `dist/`. It does not resolve
 * inside a tsup bundle that inlines this module; hosted sets `MIRA_PROMPTS_DIR`.
 */
export const BUNDLED_PROMPTS_DIR = join(MODULE_DIR, '../../../prompts')

export function loadPrompt(filename: string): string {
  return readFileSync(join(PROMPTS_DIR, filename), 'utf8')
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Reads `PROMPTS_DIR/<filename>`, falling back to the bundled default only when
 * that file does not exist. Any other read error, or ENOENT from both, throws.
 */
export function loadPromptWithBundledFallback(filename: string): string {
  try {
    return readFileSync(join(PROMPTS_DIR, filename), 'utf8')
  } catch (error) {
    if (!isMissingFile(error)) throw error
    return readFileSync(join(BUNDLED_PROMPTS_DIR, filename), 'utf8')
  }
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v), template)
}
