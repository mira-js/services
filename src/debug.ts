/** PL-2 raw-LLM diagnostics flag. Internal: not re-exported from index. Read per call. */
export function debugRawEnabled(): boolean {
  return process.env.MIRA_DEBUG_LLM_RAW === '1'
}
