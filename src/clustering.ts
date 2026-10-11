// SPDX-License-Identifier: AGPL-3.0-only
import type { ExtractionResult } from '@mira/shared-core'

// ─── Production defaults ──────────────────────────────────────────────────────
// Each constant below is what production runs today. Changing one needs the dated
// Evidence line from the item 198 sweep (Phase 2); do not flip a default without it.

/** Production default: cosine at or above this joins a seed's cluster. */
export const THEME_CLUSTER_THRESHOLD = 0.75
/** Production default: no centroid merge pass. A sweep arm when set. */
export const THEME_MERGE_THRESHOLD: number | null = null
/** Production default: seeds walk the input order. 'centroid' is a sweep arm (item 142). */
export const THEME_SEED_ORDER: 'input' | 'centroid' = 'input'
/** Production default: the embedded text is pain_points + key_quote. 'pain-only' is a sweep arm. */
export const THEME_EMBED_TEXT: EmbedTextVariant = 'legacy'

// ─── Types ────────────────────────────────────────────────────────────────────

export type EmbedTextVariant = 'legacy' | 'pain-only'

export type ClusterOptions = {
  threshold: number
  mergeThreshold: number | null
  /** keys[i] is the stable identity of item i; it breaks ties so results do not depend on input order. */
  keys: readonly string[]
  seedOrder?: 'centroid' | 'input'
}

export type ClusterStats = {
  items: number
  clusters: number
  singletons: number
  singletonRate: number
  largest: number
}

type Vec = readonly number[]
type Embeddings = readonly Vec[]

// ─── Vector helpers ───────────────────────────────────────────────────────────

// Cosine similarity, 0 when either vector is zero. A plain loop, not reduce: the sweep calls this millions of times on 1k+ dimensional vectors.
// The summation order is the one the old implementation used, so results are bit-identical.
export function cosineSimilarity(a: Vec, b: Vec): number {
  let dot = 0
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    sumA += a[i] * a[i]
    sumB += b[i] * b[i]
  }
  const magA = Math.sqrt(sumA)
  const magB = Math.sqrt(sumB)
  if (magA === 0 || magB === 0) return 0
  return dot / (magA * magB)
}

/** Rounds away float noise so a tie between two mathematically equal cosines is seen as a tie. */
function quantize(value: number): number {
  return Math.round(value * 1e9)
}

function byKey(keys: readonly string[]): (a: number, b: number) => number {
  return (a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b)
}

/** Mean of the listed vectors, summed in key order so the result does not depend on input order. */
function meanOf(embeddings: Embeddings, indices: readonly number[], keys: readonly string[]): number[] {
  if (indices.length === 0) return []
  const ordered = [...indices].sort(byKey(keys))
  const dims = embeddings[ordered[0]].length
  const sums = ordered.reduce<number[]>(
    (acc, i) => acc.map((v, d) => v + embeddings[i][d]),
    Array.from({ length: dims }, () => 0),
  )
  return sums.map((v) => v / ordered.length)
}

// ─── Seed-star clustering ─────────────────────────────────────────────────────

function seedSequence(embeddings: Embeddings, options: ClusterOptions): number[] {
  const all = embeddings.map((_, i) => i)
  if ((options.seedOrder ?? 'input') === 'input') return all
  const center = meanOf(embeddings, all, options.keys)
  const score = all.map((i) => quantize(cosineSimilarity(embeddings[i], center)))
  const tieBreak = byKey(options.keys)
  return [...all].sort((a, b) => score[b] - score[a] || tieBreak(a, b))
}

/** The old greedy algorithm: each seed takes every unassigned item within `threshold` of the seed itself. */
function seedStar(embeddings: Embeddings, sequence: readonly number[], threshold: number): number[][] {
  const assigned = new Set<number>()
  const clusters: number[][] = []
  for (const seed of sequence) {
    if (assigned.has(seed)) continue
    assigned.add(seed)
    const members = [seed]
    for (const candidate of sequence) {
      if (assigned.has(candidate)) continue
      if (cosineSimilarity(embeddings[seed], embeddings[candidate]) >= threshold) {
        assigned.add(candidate)
        members.push(candidate)
      }
    }
    clusters.push(members)
  }
  return clusters
}

/**
 * Repeatedly merges the pair of clusters whose centroids are closest, while that
 * cosine is at or above `mergeThreshold`. Ties go to the lowest cluster-index pair;
 * the merged cluster takes the earlier position.
 */
function mergeByCentroid(
  embeddings: Embeddings,
  clusters: readonly number[][],
  mergeThreshold: number,
  keys: readonly string[],
): number[][] {
  // Slot s holds cluster s; a merge keeps the earlier slot, so `active` stays in position order.
  const members = clusters.map((c) => [...c])
  const centroids = members.map((m) => meanOf(embeddings, m, keys))
  const sims = centroids.map((a) => centroids.map((b) => cosineSimilarity(a, b)))
  let active = members.map((_, s) => s)

  while (active.length > 1) {
    let best: { x: number; y: number; q: number } | null = null
    for (let x = 0; x < active.length; x++) {
      for (let y = x + 1; y < active.length; y++) {
        const sim = sims[active[x]][active[y]]
        if (sim < mergeThreshold) continue
        const q = quantize(sim)
        if (best === null || q > best.q) best = { x, y, q }
      }
    }
    if (best === null) break
    const a = active[best.x]
    const b = active[best.y]
    members[a] = [...members[a], ...members[b]]
    centroids[a] = meanOf(embeddings, members[a], keys)
    active = active.filter((s) => s !== b)
    for (const c of active) {
      if (c === a) continue
      sims[a][c] = cosineSimilarity(centroids[a], centroids[c])
      sims[c][a] = sims[a][c]
    }
  }
  return active.map((s) => members[s])
}

/**
 * Clusters `embeddings`, returning indices into it. Clusters come out in creation
 * order, members in seed order. With `seedOrder: 'input'` and `mergeThreshold: null`
 * this reproduces the original greedy algorithm exactly.
 */
export function clusterIndices(embeddings: Embeddings, options: ClusterOptions): number[][] {
  if (embeddings.length === 0) return []
  const seeded = seedStar(embeddings, seedSequence(embeddings, options), options.threshold)
  return options.mergeThreshold === null
    ? seeded
    : mergeByCentroid(embeddings, seeded, options.mergeThreshold, options.keys)
}

// ─── Average-linkage agglomeration (sweep arm) ────────────────────────────────

/**
 * Average-linkage agglomerative clustering: repeatedly merges the two clusters with
 * the highest mean pairwise cosine while it is at or above `similarityCutoff`.
 * Order-independent given `keys`. Not used by production code.
 */
export function agglomerateAverage(
  embeddings: Embeddings,
  options: { similarityCutoff: number; keys: readonly string[] },
): number[][] {
  if (embeddings.length === 0) return []
  const order = embeddings.map((_, i) => i).sort(byKey(options.keys))
  // Slot s holds the cluster seeded by order[s]; a merge keeps the earlier slot.
  const sums = order.map((i) => order.map((j) => cosineSimilarity(embeddings[i], embeddings[j])))
  const members = order.map((i) => [i])
  let active = order.map((_, s) => s)

  while (active.length > 1) {
    let best: { x: number; y: number; q: number } | null = null
    for (let x = 0; x < active.length; x++) {
      for (let y = x + 1; y < active.length; y++) {
        const a = active[x]
        const b = active[y]
        const mean = sums[a][b] / (members[a].length * members[b].length)
        if (mean < options.similarityCutoff) continue
        const q = quantize(mean)
        if (best === null || q > best.q) best = { x, y, q }
      }
    }
    if (best === null) break
    const a = active[best.x]
    const b = active[best.y]
    for (const c of active) {
      if (c === a || c === b) continue
      sums[a][c] += sums[b][c]
      sums[c][a] = sums[a][c]
    }
    members[a] = [...members[a], ...members[b]]
    active = active.filter((s) => s !== b)
  }
  return active.map((s) => members[s])
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

/** For each item, its highest cosine to any other item; 0 when there is no other item or the vector is zero. */
export function nearestNeighbourSimilarities(embeddings: Embeddings): number[] {
  return embeddings.map((v, i) =>
    embeddings.reduce<number | null>((best, w, j) => {
      if (i === j) return best
      const sim = cosineSimilarity(v, w)
      return best === null || sim > best ? sim : best
    }, null) ?? 0,
  )
}

/** Up to `limit` index pairs [i, j], i < j, whose cosine is within `margin` of `threshold`, closest first. */
export function boundaryPairs(
  embeddings: Embeddings,
  threshold: number,
  margin: number,
  limit: number,
): [number, number][] {
  const found: { i: number; j: number; gap: number }[] = []
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const gap = Math.abs(cosineSimilarity(embeddings[i], embeddings[j]) - threshold)
      if (quantize(gap) <= quantize(margin)) found.push({ i, j, gap: quantize(gap) })
    }
  }
  return found
    .sort((a, b) => a.gap - b.gap || a.i - b.i || a.j - b.j)
    .slice(0, Math.max(0, limit))
    .map(({ i, j }): [number, number] => [i, j])
}

export function clusterStats(clusters: readonly (readonly unknown[])[]): ClusterStats {
  const items = clusters.reduce((sum, c) => sum + c.length, 0)
  const singletons = clusters.filter((c) => c.length === 1).length
  return {
    items,
    clusters: clusters.length,
    singletons,
    singletonRate: items === 0 ? 0 : singletons / items,
    largest: clusters.reduce((max, c) => Math.max(max, c.length), 0),
  }
}

// ─── Embedded text ────────────────────────────────────────────────────────────

// Never send '' to the embedder: Jina rejects an empty input and the whole batch fails after extraction is paid for.
const EMPTY_EMBED_TEXT = '(no text)'

/**
 * The text sent to the embedder for one extraction. 'legacy' is the shipped
 * `pain_points + key_quote`; 'pain-only' drops the quote unless there are no
 * usable pain points, and returns a fixed sentinel when the quote is blank too.
 */
export function themeEmbeddingText(
  extraction: Pick<ExtractionResult, 'pain_points' | 'key_quote'>,
  variant: EmbedTextVariant,
): string {
  if (variant === 'legacy') return extraction.pain_points.join(' ') + ' ' + extraction.key_quote
  const points = extraction.pain_points.map((p) => p.trim()).filter((p) => p !== '')
  if (points.length > 0) return points.join('; ')
  return extraction.key_quote.trim() !== '' ? extraction.key_quote : EMPTY_EMBED_TEXT
}
