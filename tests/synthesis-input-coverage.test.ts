import { describe, it, expect } from 'vitest'
import type { PainPointTheme } from '@mira/shared-core'
import { selectSynthesisInput } from '../src/synthesis-input.js'

const painPoints: PainPointTheme[] = [
  { theme: 'Slow exports', frequency: 3, sources: ['reddit'], sentiment: -0.5, evidence: [] },
]
const buckets = { painPoints, competitorWeaknesses: [], emergingGaps: [] }

describe('selectSynthesisInput coverage', () => {
  it('[unhappy] an empty productCommunitiesDropped list produces no coverage key', () => {
    const input = selectSynthesisInput(buckets, undefined, { productCommunitiesDropped: [] })

    expect('coverage' in input).toBe(false)
    expect(Object.keys(input).sort()).toEqual(['competitorWeaknesses', 'emergingGaps', 'painPoints', 'sample'])
    // The empty case is the absence of a key the non-empty case does set.
    const withList = selectSynthesisInput(buckets, undefined, { productCommunitiesDropped: ['X'] })
    expect(withList.coverage).toEqual({ productCommunitiesDropped: ['X'] })
  })

  it('[unhappy] omitting the third argument produces no coverage key', () => {
    const input = selectSynthesisInput(buckets, { analyzedItems: 4, sourceCounts: { reddit: 4 } })

    expect('coverage' in input).toBe(false)
    expect(JSON.stringify(input)).not.toContain('coverage')
    const withList = selectSynthesisInput(buckets, { analyzedItems: 4, sourceCounts: { reddit: 4 } }, { productCommunitiesDropped: ['X'] })
    expect(JSON.stringify(withList)).toContain('"coverage":{"productCommunitiesDropped":["X"]}')
  })

  it('[happy] a non-empty third argument is carried as coverage.productCommunitiesDropped', () => {
    const input = selectSynthesisInput(buckets, undefined, { productCommunitiesDropped: ['DressmakerGame'] })

    expect(input.coverage).toEqual({ productCommunitiesDropped: ['DressmakerGame'] })
  })

  it('[happy] two-arg call output is unchanged (expect: green)', () => {
    const input = selectSynthesisInput(buckets, { analyzedItems: 4, sourceCounts: { reddit: 4 } })

    expect(Object.keys(input).sort()).toEqual(['competitorWeaknesses', 'emergingGaps', 'painPoints', 'sample'])
    expect(input.sample).toEqual({ analyzedItems: 4, sourceCounts: { reddit: 4 }, basis: 'items' })
    expect(input.painPoints.themes).toHaveLength(1)
    expect(input.painPoints.themes[0].id).toBe('pp-0')
  })
})
