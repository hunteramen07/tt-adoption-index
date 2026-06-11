import {
  AUM_GROWTH_RANGE,
  HOLDER_GROWTH_RANGE,
  CONCENTRATION_TREND_RANGE,
  DORMANCY_TREND_RANGE,
  TRANSFER_ACTIVITY_RANGE,
  BREADTH_RANGE,
  METHODOLOGY_VERSION,
  type FactorRange,
} from '@/src/config/index-ranges'
import type { FactorInputs, FactorScore, IndexReading } from './types'

const FACTOR_WEIGHTS = {
  aumGrowth3m:           0.25,
  holderGrowth3m:        0.20,
  concentrationDelta3m:  0.20,
  dormancyDelta3m:       0.15,
  transferActivityRatio: 0.10,
  breadth:               0.10,
} as const

type FactorKey = keyof typeof FACTOR_WEIGHTS

/**
 * Maps a raw factor value to a 0–100 score using a defined linear range.
 *
 * If range.neutral is set: piecewise linear with two separate slopes so that
 * the neutral value always maps to exactly 50. This matches the methodology
 * convention that a flat (0% change) signal produces a score of 50.
 *
 * Without neutral: simple linear mapping from lo→0 to hi→100.
 *
 * Result is always clamped to [0, 100].
 */
export function normalizeScore(raw: number, range: FactorRange): number {
  const { lo, neutral, hi } = range
  let score: number

  if (neutral !== undefined) {
    if (raw <= neutral) {
      const denom = neutral - lo
      score = denom === 0 ? 50 : 50 * (raw - lo) / denom
    } else {
      const denom = hi - neutral
      score = denom === 0 ? 50 : 50 + 50 * (raw - neutral) / denom
    }
  } else {
    const denom = hi - lo
    score = denom === 0 ? 50 : (raw - lo) / denom * 100
  }

  return Math.max(0, Math.min(100, score))
}

/**
 * Computes the RTA Index composite and per-factor sub-scores from raw inputs.
 *
 * Factors 3 and 4 (concentration and dormancy trend) are "declining is good":
 * their raw deltas are negated before normalization so that a falling share
 * produces a high score. FactorScore.raw stores the original un-negated delta.
 *
 * Missing factors (undefined inputs) are excluded from the weighted mean.
 * Remaining weights are renormalized to sum to 1.0. Partial readings are
 * flagged with isPartial=true and a partialReason description.
 *
 * Throws if no factors are available.
 */
export function computeIndexReading(inputs: FactorInputs): IndexReading {
  const factors: IndexReading['factors'] = {}
  const available: Array<{ key: FactorKey; score: number; weight: number }> = []

  function record(key: FactorKey, raw: number, scoreValue: number) {
    ;(factors as Record<string, FactorScore>)[key] = { raw, score: scoreValue }
    available.push({ key, score: scoreValue, weight: FACTOR_WEIGHTS[key] })
  }

  // Factor 1: AUM growth — higher is better
  if (inputs.aumGrowth3m !== undefined) {
    record('aumGrowth3m', inputs.aumGrowth3m, normalizeScore(inputs.aumGrowth3m, AUM_GROWTH_RANGE))
  }

  // Factor 2: Holder growth — higher is better
  if (inputs.holderGrowth3m !== undefined) {
    record('holderGrowth3m', inputs.holderGrowth3m, normalizeScore(inputs.holderGrowth3m, HOLDER_GROWTH_RANGE))
  }

  // Factor 3: Concentration trend — declining share is better.
  // Negate delta so that falling share → positive normalized input → high score.
  if (inputs.concentrationDelta3m !== undefined) {
    const score = normalizeScore(-inputs.concentrationDelta3m, CONCENTRATION_TREND_RANGE)
    record('concentrationDelta3m', inputs.concentrationDelta3m, score)
  }

  // Factor 4: Dormancy trend — declining share is better. Same negation logic.
  if (inputs.dormancyDelta3m !== undefined) {
    const score = normalizeScore(-inputs.dormancyDelta3m, DORMANCY_TREND_RANGE)
    record('dormancyDelta3m', inputs.dormancyDelta3m, score)
  }

  // Factor 5: Transfer activity ratio
  if (inputs.transferActivityRatio !== undefined) {
    record('transferActivityRatio', inputs.transferActivityRatio, normalizeScore(inputs.transferActivityRatio, TRANSFER_ACTIVITY_RANGE))
  }

  // Factor 6: Breadth
  if (inputs.breadth !== undefined) {
    record('breadth', inputs.breadth, normalizeScore(inputs.breadth, BREADTH_RANGE))
  }

  if (available.length === 0) {
    throw new Error(`computeIndexReading: no factors available for ${inputs.readingDate}`)
  }

  const totalWeight = available.reduce((sum, f) => sum + f.weight, 0)
  const composite = available.reduce((sum, f) => sum + (f.weight / totalWeight) * f.score, 0)

  const missingKeys = (Object.keys(FACTOR_WEIGHTS) as FactorKey[]).filter(
    (k) => inputs[k] === undefined
  )
  const isPartial = missingKeys.length > 0
  const partialReason = isPartial
    ? `${missingKeys.length} factor(s) unavailable: ${missingKeys.join(', ')}`
    : null

  return {
    readingDate: inputs.readingDate,
    composite: Math.round(composite * 100) / 100,
    factors,
    isPartial,
    partialReason,
    methodologyVersion: METHODOLOGY_VERSION,
  }
}
