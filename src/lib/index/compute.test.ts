/**
 * Unit tests for computeIndexReading and normalizeScore.
 * Run with: npm run test:index
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeScore, computeIndexReading } from './compute.js'
import type { FactorInputs } from './types.js'
import {
  AUM_GROWTH_RANGE,
  CONCENTRATION_TREND_RANGE,
  DORMANCY_TREND_RANGE,
  BREADTH_RANGE,
} from '@/src/config/index-ranges.js'

// ── normalizeScore ────────────────────────────────────────────────────────

describe('normalizeScore — piecewise linear (with neutral)', () => {
  const range = AUM_GROWTH_RANGE // lo=-0.40, neutral=0, hi=0.65

  test('neutral value → exactly 50', () => {
    assert.equal(normalizeScore(0, range), 50)
  })

  test('lo value → exactly 0', () => {
    assert.equal(normalizeScore(-0.40, range), 0)
  })

  test('hi value → exactly 100', () => {
    assert.equal(normalizeScore(0.65, range), 100)
  })

  test('clamps below lo to 0', () => {
    assert.equal(normalizeScore(-0.50, range), 0)
  })

  test('clamps above hi to 100', () => {
    assert.equal(normalizeScore(1.00, range), 100)
  })

  test('midpoint between lo and neutral → 25', () => {
    // raw = -0.20 is halfway between lo=-0.40 and neutral=0
    assert.equal(normalizeScore(-0.20, range), 25)
  })

  test('midpoint between neutral and hi → 75', () => {
    // raw = 0.325 is halfway between neutral=0 and hi=0.65
    assert.equal(normalizeScore(0.325, range), 75)
  })
})

describe('normalizeScore — simple linear (no neutral)', () => {
  const range = BREADTH_RANGE // lo=1, hi=6

  test('lo → 0', () => {
    assert.equal(normalizeScore(1, range), 0)
  })

  test('hi → 100', () => {
    assert.equal(normalizeScore(6, range), 100)
  })

  test('midpoint → 50', () => {
    // raw=3.5 is midpoint of [1,6]
    assert.equal(normalizeScore(3.5, range), 50)
  })

  test('clamps below lo to 0', () => {
    assert.equal(normalizeScore(0, range), 0)
  })

  test('clamps above hi to 100', () => {
    assert.equal(normalizeScore(10, range), 100)
  })
})

// ── Range clamping ────────────────────────────────────────────────────────

describe('normalizeScore — clamping', () => {
  test('far below lo still returns 0 (no negative scores)', () => {
    assert.equal(normalizeScore(-999, AUM_GROWTH_RANGE), 0)
  })

  test('far above hi still returns 100 (no scores over 100)', () => {
    assert.equal(normalizeScore(999, AUM_GROWTH_RANGE), 100)
  })
})

// ── Declining-is-good factors: sign inversion in computeIndexReading ──────

describe('concentration and dormancy sign inversion', () => {
  test('negative concentrationDelta (falling) → high score', () => {
    const r = computeIndexReading({
      readingDate: '2024-01-31',
      concentrationDelta3m: -CONCENTRATION_TREND_RANGE.hi, // fell to −hi (best case)
    })
    assert.equal(r.factors.concentrationDelta3m!.score, 100)
  })

  test('positive concentrationDelta (rising) → low score', () => {
    const r = computeIndexReading({
      readingDate: '2024-01-31',
      concentrationDelta3m: CONCENTRATION_TREND_RANGE.hi, // rose to hi (worst case)
    })
    assert.equal(r.factors.concentrationDelta3m!.score, 0)
  })

  test('zero concentrationDelta → neutral 50', () => {
    const r = computeIndexReading({
      readingDate: '2024-01-31',
      concentrationDelta3m: 0,
    })
    assert.equal(r.factors.concentrationDelta3m!.score, 50)
  })

  test('raw value stored is the original (un-negated) delta', () => {
    const delta = 0.07
    const r = computeIndexReading({
      readingDate: '2024-01-31',
      concentrationDelta3m: delta,
    })
    assert.equal(r.factors.concentrationDelta3m!.raw, delta)
  })

  test('negative dormancyDelta → high score', () => {
    // Dormancy trend range is ±0.35 (wider than concentration's ±0.15), so a
    // falling dormancy share saturates to 100 only at −hi.
    const r = computeIndexReading({
      readingDate: '2024-01-31',
      dormancyDelta3m: -DORMANCY_TREND_RANGE.hi,
    })
    assert.equal(r.factors.dormancyDelta3m!.score, 100)
  })

  test('positive dormancyDelta → low score', () => {
    const r = computeIndexReading({
      readingDate: '2024-01-31',
      dormancyDelta3m: DORMANCY_TREND_RANGE.hi,
    })
    assert.equal(r.factors.dormancyDelta3m!.score, 0)
  })
})

// ── Missing-factor renormalization ────────────────────────────────────────

describe('missing factor renormalization', () => {
  test('all factors provided, all at neutral → composite = 50', () => {
    const inputs: FactorInputs = {
      readingDate: '2024-01-31',
      aumGrowth3m: 0,
      holderGrowth3m: 0,
      concentrationDelta3m: 0,
      dormancyDelta3m: 0,
      transferActivityRatio: 1.0,
      breadth: 3.5, // midpoint of BREADTH_RANGE (1–6) via simple linear → 50
    }
    const r = computeIndexReading(inputs)
    assert.equal(r.composite, 50)
    assert.equal(r.isPartial, false)
    assert.equal(r.partialReason, null)
  })

  test('only breadth provided → composite = breadth score, isPartial = true', () => {
    const inputs: FactorInputs = {
      readingDate: '2024-01-31',
      breadth: 6, // hi → 100
    }
    const r = computeIndexReading(inputs)
    assert.equal(r.composite, 100)
    assert.equal(r.isPartial, true)
    assert.ok(r.partialReason?.includes('5 factor(s)'))
  })

  test('5 of 6 factors missing → weights renormalize to the one present factor', () => {
    // Only aumGrowth3m = 0 (neutral → 50). With renormalization, weight = 1.0.
    const r = computeIndexReading({ readingDate: '2024-06-30', aumGrowth3m: 0 })
    assert.equal(r.composite, 50)
    assert.equal(r.isPartial, true)
  })

  test('two factors missing → composite is weighted mean of remaining four', () => {
    // aumGrowth3m=0.65 (hi →100, weight 25%), holderGrowth3m=0 (→50, weight 20%),
    // concentrationDelta3m=0 (→50, weight 20%), dormancyDelta3m=0 (→50, weight 15%)
    // Missing: transferActivityRatio (10%), breadth (10%).
    // Total available weight = 0.80. Renorm factors: /0.80 each.
    // Composite = (0.25*100 + 0.20*50 + 0.20*50 + 0.15*50) / 0.80
    //           = (25 + 10 + 10 + 7.5) / 0.80 = 52.5 / 0.80 = 65.625
    const r = computeIndexReading({
      readingDate: '2024-01-31',
      aumGrowth3m: 0.65,
      holderGrowth3m: 0,
      concentrationDelta3m: 0,
      dormancyDelta3m: 0,
    })
    assert.ok(Math.abs(r.composite - 65.63) < 0.01, `expected ~65.63, got ${r.composite}`)
    assert.equal(r.isPartial, true)
  })

  test('all factors at maximum → composite = 100', () => {
    const r = computeIndexReading({
      readingDate: '2024-01-31',
      aumGrowth3m: 0.65,           // hi
      holderGrowth3m: 0.30,
      concentrationDelta3m: -0.15, // best = falling 15pp
      dormancyDelta3m: -0.35,      // best = falling 35pp
      transferActivityRatio: 3.0,
      breadth: 6,
    })
    assert.equal(r.composite, 100)
  })

  test('all factors at minimum → composite = 0', () => {
    const r = computeIndexReading({
      readingDate: '2024-01-31',
      aumGrowth3m: -0.40,          // lo
      holderGrowth3m: -0.10,
      concentrationDelta3m: 0.15, // worst = rising 15pp
      dormancyDelta3m: 0.35,       // worst = rising 35pp
      transferActivityRatio: 0,
      breadth: 1,
    })
    assert.equal(r.composite, 0)
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────

describe('edge cases', () => {
  test('throws when no factors are provided', () => {
    assert.throws(
      () => computeIndexReading({ readingDate: '2024-01-31' }),
      /no factors available/
    )
  })

  test('composite is rounded to 2 decimal places', () => {
    // Verify the output is not a raw floating point with many decimal places
    const r = computeIndexReading({ readingDate: '2024-01-31', aumGrowth3m: 0.10 })
    const decimals = r.composite.toString().split('.')[1]?.length ?? 0
    assert.ok(decimals <= 2, `expected ≤2 decimal places, got ${decimals}`)
  })

  test('methodologyVersion is set correctly', () => {
    const r = computeIndexReading({ readingDate: '2024-01-31', breadth: 3 })
    assert.equal(r.methodologyVersion, '1.1')
  })

  test('factors not in input are absent from output', () => {
    const r = computeIndexReading({ readingDate: '2024-01-31', breadth: 3 })
    assert.equal(r.factors.aumGrowth3m, undefined)
    assert.equal(r.factors.holderGrowth3m, undefined)
  })

  test('normalizeScore with zero-width range returns 50', () => {
    // lo === hi: degenerate range — should not crash
    const score = normalizeScore(5, { lo: 5, hi: 5 })
    assert.equal(score, 50)
  })

  test('normalizeScore with lo === neutral returns 50 for raw === neutral', () => {
    const score = normalizeScore(0, { lo: 0, neutral: 0, hi: 1 })
    assert.equal(score, 50)
  })
})
