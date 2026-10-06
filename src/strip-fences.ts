// SPDX-License-Identifier: AGPL-3.0-only

const BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [['[', ']'], ['{', '}']]

function isWrappedIn(text: string, opener: string, closer: string): boolean {
  return text.startsWith(opener) && text.endsWith(closer)
}

/**
 * Reduces a raw LLM reply to the JSON text to parse. Pure and total.
 *
 * 1. Trim, then strip a leading ```` ```json ```` / ```` ``` ```` fence and a
 *    trailing ```` ``` ```` fence, then trim again.
 * 2. If the result already starts and ends with a matching `[`/`]` or `{`/`}`
 *    pair, return it.
 * 3. Otherwise fall back to the outermost bracket span: the opener is whichever
 *    of `[` / `{` appears first, the closer is the last index of its match. This
 *    drops prose before a fence or after the JSON, and keeps an object root
 *    whole even when it contains an array.
 * 4. With no such pair, return the unfenced text unchanged, so `JSON.parse`
 *    still fails on it and the caller tags it as a parse error.
 */
export function stripFences(raw: string): string {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?[ \t]*\r?\n?/i, '')
    .replace(/\r?\n?```$/i, '')
    .trim()

  if (BRACKET_PAIRS.some(([opener, closer]) => isWrappedIn(unfenced, opener, closer))) {
    return unfenced
  }

  const candidates = BRACKET_PAIRS
    .map(([opener, closer]) => ({ first: unfenced.indexOf(opener), closer }))
    .filter(({ first }) => first !== -1)
    .sort((a, b) => a.first - b.first)
  const earliest = candidates[0]
  if (!earliest) return unfenced

  const last = unfenced.lastIndexOf(earliest.closer)
  return last > earliest.first ? unfenced.slice(earliest.first, last + 1) : unfenced
}
