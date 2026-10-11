import { describe, it, expect } from 'vitest'
import {
  clusterIndices,
  clusterStats,
  agglomerateAverage,
  nearestNeighbourSimilarities,
  boundaryPairs,
  themeEmbeddingText,
} from '../src/clustering.js'

const at = (deg: number): number[] => {
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
}

// Legacy chain: A=0deg, B=20deg, C=40deg. cos(A,B)=cos(B,C)=0.9397, cos(A,C)=0.766.
const chain = (): number[][] => [at(0), at(20), at(40)]
const chainKeys = ['a', 'b', 'c']

const canon = (clusters: readonly (readonly number[])[], keys: readonly string[]): string[][] =>
  clusters
    .map((c) => c.map((i) => keys[i]).sort())
    .sort((x, y) => x.join('|').localeCompare(y.join('|')))

const permutations = (n: number): number[][] => {
  const out: number[][] = []
  const walk = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) {
      out.push(prefix)
      return
    }
    rest.forEach((v, idx) => walk([...prefix, v], [...rest.slice(0, idx), ...rest.slice(idx + 1)]))
  }
  walk([], Array.from({ length: n }, (_, i) => i))
  return out
}

describe('clusterIndices', () => {
  it('[unhappy] seedOrder centroid on the legacy chain seeds the most central item (B) and gives one cluster', () => {
    const result = clusterIndices(chain(), { threshold: 0.9, mergeThreshold: null, keys: chainKeys, seedOrder: 'centroid' })
    expect(result).toEqual([[1, 0, 2]])
  })

  it('[unhappy] empty input gives empty output', () => {
    expect(clusterIndices([], { threshold: 0.9, mergeThreshold: null, keys: [] })).toEqual([])
  })

  it('[unhappy] a zero vector among others becomes its own singleton, with no NaN and no throw', () => {
    const embeddings = [[1, 0], [0, 0], [1, 0]]
    const keys = ['a', 'b', 'c']
    for (const seedOrder of ['input', 'centroid'] as const) {
      for (const mergeThreshold of [null, 0.5]) {
        const result = clusterIndices(embeddings, { threshold: 0.5, mergeThreshold, keys, seedOrder })
        const flat = result.flat()
        expect(flat.every((i) => Number.isInteger(i))).toBe(true)
        expect([...flat].sort()).toEqual([0, 1, 2])
        expect(canon(result, keys)).toEqual([['a', 'c'], ['b']])
      }
    }
  })

  it('[unhappy] merge pass joins two clusters whose centroids are at or above the merge threshold (cos 0.8)', () => {
    const embeddings = [[1, 0], [1, 0], [0.8, 0.6], [0.8, 0.6]]
    const keys = ['a', 'b', 'c', 'd']
    const run = (mergeThreshold: number | null) =>
      clusterIndices(embeddings, { threshold: 0.95, mergeThreshold, keys, seedOrder: 'input' })
    expect(run(null)).toHaveLength(2)
    expect(run(0.85)).toHaveLength(2)
    const merged = run(0.75)
    expect(merged).toHaveLength(1)
    expect([...merged[0]].sort()).toEqual([0, 1, 2, 3])
  })

  it('[unhappy] the merged cluster takes the earlier position', () => {
    // X=[1,0], G=[0,1] (orthogonal to both), Y=[0.8,0.6]: cos(X,Y)=0.8, cos(G,Y)=0.6.
    const embeddings = [[1, 0], [0, 1], [0.8, 0.6]]
    const result = clusterIndices(embeddings, { threshold: 0.95, mergeThreshold: 0.75, keys: ['x', 'g', 'y'], seedOrder: 'input' })
    expect(result.map((c) => [...c].sort())).toEqual([[0, 2], [1]])
  })

  it('[unhappy] the merge pass merges the highest-cosine centroid pair first', () => {
    // A=0deg, B=30deg, C=50deg. cos(B,C)=0.940 is the highest; merging it first leaves A at 0.766 from {B,C} (< 0.8).
    // Merging A,B first (0.866) would put {A,B} at 15deg, 0.819 from C, and collapse everything.
    const embeddings = [at(0), at(30), at(50)]
    const result = clusterIndices(embeddings, { threshold: 0.99, mergeThreshold: 0.8, keys: ['a', 'b', 'c'], seedOrder: 'input' })
    expect(result.map((c) => [...c].sort())).toEqual([[0], [1, 2]])
  })

  it('[unhappy] centroid seeding is permutation-invariant (tied centroid scores), merge off and on', () => {
    const keys = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2']
    const tied: number[][] = [[1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1]]
    const mergeable: number[][] = [[1, 0, 0], [1, 0, 0], [0.8, 0.6, 0], [0.8, 0.6, 0], [0, 0, 1], [0, 0, 1]]
    const perms = permutations(keys.length)
    expect(perms).toHaveLength(720)

    const cases: { embeddings: number[][]; mergeThreshold: number | null; expected: string[][] }[] = [
      { embeddings: tied, mergeThreshold: null, expected: [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']] },
      { embeddings: tied, mergeThreshold: 0.5, expected: [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']] },
      { embeddings: mergeable, mergeThreshold: null, expected: [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']] },
      { embeddings: mergeable, mergeThreshold: 0.75, expected: [['a1', 'a2', 'b1', 'b2'], ['c1', 'c2']] },
    ]

    for (const { embeddings, mergeThreshold, expected } of cases) {
      for (const perm of perms) {
        const pe = perm.map((i) => embeddings[i])
        const pk = perm.map((i) => keys[i])
        const result = clusterIndices(pe, { threshold: 0.95, mergeThreshold, keys: pk, seedOrder: 'centroid' })
        expect(canon(result, pk)).toEqual(expected)
      }
    }
  })

  it('[unhappy] centroid seeding breaks tied scores on keys: seeds are a1, b1, c1 for every permutation', () => {
    const keys = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2']
    const tied: number[][] = [[1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1]]
    for (const perm of permutations(keys.length)) {
      const pe = perm.map((i) => tied[i])
      const pk = perm.map((i) => keys[i])
      const result = clusterIndices(pe, { threshold: 0.95, mergeThreshold: null, keys: pk, seedOrder: 'centroid' })
      expect(result.map((c) => pk[c[0]])).toEqual(['a1', 'b1', 'c1'])
    }
  })

  it('[happy] seedOrder input with no merge reproduces the old seed-star on the legacy chain at 0.9', () => {
    const result = clusterIndices(chain(), { threshold: 0.9, mergeThreshold: null, keys: chainKeys, seedOrder: 'input' })
    expect(result).toEqual([[0, 1], [2]])
  })

  it('[happy] seedOrder defaults to input', () => {
    const result = clusterIndices(chain(), { threshold: 0.9, mergeThreshold: null, keys: chainKeys })
    expect(result).toEqual([[0, 1], [2]])
  })

  it('[happy] identical vectors give one cluster; orthogonal vectors give one singleton each', () => {
    for (const seedOrder of ['input', 'centroid'] as const) {
      const same = clusterIndices([[1, 0], [1, 0], [1, 0]], { threshold: 0.9, mergeThreshold: null, keys: ['a', 'b', 'c'], seedOrder })
      expect(same).toHaveLength(1)
      expect([...same[0]].sort()).toEqual([0, 1, 2])

      const ortho = clusterIndices([[1, 0, 0], [0, 1, 0], [0, 0, 1]], { threshold: 0.9, mergeThreshold: null, keys: ['a', 'b', 'c'], seedOrder })
      expect(ortho).toHaveLength(3)
      expect(ortho.every((c) => c.length === 1)).toBe(true)
    }
  })
})

describe('clusterStats', () => {
  it('[happy] summarises clusters', () => {
    expect(clusterStats([[0, 1], [2], [3]])).toEqual({ items: 4, clusters: 3, singletons: 2, singletonRate: 0.5, largest: 2 })
  })

  it('[happy] empty input gives all zeros with singletonRate 0', () => {
    expect(clusterStats([])).toEqual({ items: 0, clusters: 0, singletons: 0, singletonRate: 0, largest: 0 })
  })
})

describe('agglomerateAverage', () => {
  it('[unhappy] legacy chain at cutoff 0.9 gives [[0,1],[2]]', () => {
    const result = agglomerateAverage(chain(), { similarityCutoff: 0.9, keys: chainKeys })
    expect(result.map((c) => [...c].sort())).toEqual([[0, 1], [2]])
  })

  it('[unhappy] legacy chain at cutoff 0.85 gives one cluster (mean cosine of C to {A,B} is about 0.853)', () => {
    const result = agglomerateAverage(chain(), { similarityCutoff: 0.85, keys: chainKeys })
    expect(result).toHaveLength(1)
    expect([...result[0]].sort()).toEqual([0, 1, 2])
  })

  it('[unhappy] a permutation of the inputs gives the same clusters mapped back to keys', () => {
    for (const cutoff of [0.9, 0.85]) {
      const base = canon(agglomerateAverage(chain(), { similarityCutoff: cutoff, keys: chainKeys }), chainKeys)
      for (const perm of permutations(3)) {
        const pe = perm.map((i) => chain()[i])
        const pk = perm.map((i) => chainKeys[i])
        expect(canon(agglomerateAverage(pe, { similarityCutoff: cutoff, keys: pk }), pk)).toEqual(base)
      }
    }
  })

  it('[unhappy] empty input gives empty output', () => {
    expect(agglomerateAverage([], { similarityCutoff: 0.9, keys: [] })).toEqual([])
  })
})

describe('nearestNeighbourSimilarities', () => {
  it('[unhappy] empty gives empty, a single item gives [0]', () => {
    expect(nearestNeighbourSimilarities([])).toEqual([])
    expect(nearestNeighbourSimilarities([[1, 0]])).toEqual([0])
  })

  it('[unhappy] the legacy chain gives three values of about 0.9397', () => {
    const result = nearestNeighbourSimilarities(chain())
    expect(result).toHaveLength(3)
    for (const v of result) expect(v).toBeCloseTo(0.9397, 3)
  })

  it('[unhappy] a zero vector gives 0 for that item and does not disturb the others', () => {
    const result = nearestNeighbourSimilarities([[1, 0], [0, 0], [1, 0]])
    expect(result).toHaveLength(3)
    expect(result[0]).toBeCloseTo(1, 6)
    expect(result[1]).toBe(0)
    expect(result[2]).toBeCloseTo(1, 6)
  })
})

describe('boundaryPairs', () => {
  // 0deg, 20deg, 26deg. cos(0,26)=0.8988 (|diff| 0.0012), cos(0,20)=0.9397 (0.0397), cos(20,26)=0.9945 (0.0945).
  const embeddings = [at(0), at(20), at(26)]

  it('[unhappy] returns only pairs within margin, ordered by closeness, i < j', () => {
    expect(boundaryPairs(embeddings, 0.9, 0.05, 10)).toEqual([[0, 2], [0, 1]])
  })

  it('[unhappy] truncates to limit', () => {
    expect(boundaryPairs(embeddings, 0.9, 0.05, 1)).toEqual([[0, 2]])
  })

  it('[unhappy] ties on closeness are ordered by (i, j)', () => {
    // 0deg, 20deg, 40deg: cos(0,20) = cos(20,40) = 0.9397, cos(0,40) = 0.766 (outside margin).
    expect(boundaryPairs(chain(), 0.9, 0.05, 10)).toEqual([[0, 1], [1, 2]])
  })

  it('[unhappy] returns none when no pair qualifies', () => {
    expect(boundaryPairs(embeddings, 0.5, 0.01, 10)).toEqual([])
  })
})

describe('themeEmbeddingText', () => {
  it('[unhappy] pain-only with no pain points falls back to key_quote', () => {
    expect(themeEmbeddingText({ pain_points: [], key_quote: 'the quote' }, 'pain-only')).toBe('the quote')
  })

  it('[unhappy] pain-only with only blank pain points falls back to key_quote, never empty', () => {
    const text = themeEmbeddingText({ pain_points: ['  ', ''], key_quote: 'the quote' }, 'pain-only')
    expect(text).toBe('the quote')
    expect(text).not.toBe('')
  })

  it('[unhappy] pain-only with no pain points and an empty key_quote is never blank', () => {
    const text = themeEmbeddingText({ pain_points: [], key_quote: '' }, 'pain-only')
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('[unhappy] pain-only with only blank pain points and an empty key_quote is never blank', () => {
    const text = themeEmbeddingText({ pain_points: ['  ', ''], key_quote: '' }, 'pain-only')
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('[unhappy] pain-only with no pain points and a whitespace-only key_quote is never blank', () => {
    const text = themeEmbeddingText({ pain_points: [], key_quote: '   ' }, 'pain-only')
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('[unhappy] pain-only trims and drops blank pain points', () => {
    expect(themeEmbeddingText({ pain_points: [' a ', '', '  ', 'b'], key_quote: 'q' }, 'pain-only')).toBe('a; b')
  })

  it('[happy] legacy is exactly pain_points joined by space, a space, then key_quote', () => {
    expect(themeEmbeddingText({ pain_points: ['a', 'b'], key_quote: 'q' }, 'legacy')).toBe('a b q')
  })

  it('[happy] pain-only joins pain points with "; "', () => {
    expect(themeEmbeddingText({ pain_points: ['a', 'b'], key_quote: 'q' }, 'pain-only')).toBe('a; b')
  })
})
