/**
 * Normalization ranges for the RTA Index v1.0 factors.
 *
 * Calibrated against the Jan 2023–May 2026 backfill on 2026-06-11.
 * Ranges are fixed in code; changes require a methodology version bump.
 *
 * Range semantics:
 *   lo      → score   0  (worst expected value)
 *   neutral → score  50  (neutral / flat signal; omit for monotone factors)
 *   hi      → score 100  (best expected value)
 *
 * For factors 3 and 4 the raw input is the change in concentration/dormancy
 * share. compute.ts negates these inputs before normalizing, so the range
 * is expressed in terms of the negated value (positive = declining share = good).
 *
 * Changing any value here is a methodology change and requires a version bump.
 */

export interface FactorRange {
  /** Raw value that maps to score 0 */
  lo: number
  /**
   * Raw value that maps to score 50 (piecewise-linear anchor).
   * When set, the normalization function uses two separate slopes
   * (lo→neutral and neutral→hi) so that "neutral" always produces
   * a score of exactly 50. Omit for simple linear (monotone) factors.
   */
  neutral?: number
  /** Raw value that maps to score 100 */
  hi: number
}

// ── Factor 1: AUM growth (3-month fraction, e.g. 0.15 = +15%) ────────────
// neutral=0 enforces: flat growth → 50 (consistent with the methodology example)
// Calibrated: -40% → 0,  0% → 50,  +65% → 100
export const AUM_GROWTH_RANGE: FactorRange = {
  lo: -0.40,
  neutral: 0,
  hi: 0.65,
} as const

// ── Factor 2: Holder growth (3-month fraction) ────────────────────────────
// Calibrated: -10% → 0,  0% → 50,  +30% → 100
export const HOLDER_GROWTH_RANGE: FactorRange = {
  lo: -0.10,
  neutral: 0,
  hi: 0.30,
} as const

// ── Factor 3: Concentration trend (negated Δ top-5 share) ─────────────────
// compute.ts feeds in (-concentrationDelta3m), so positive = declining share = good.
// Calibrated: -15pp change → 0,  0 → 50,  +15pp → 100
export const CONCENTRATION_TREND_RANGE: FactorRange = {
  lo: -0.15,
  neutral: 0,
  hi: 0.15,
} as const

// ── Factor 4: Dormancy trend (negated Δ dormancy share) ───────────────────
// compute.ts feeds in (-dormancyDelta3m), so positive = declining dormancy = good.
// Calibrated: -35pp change → 0,  0 → 50,  +35pp → 100
export const DORMANCY_TREND_RANGE: FactorRange = {
  lo: -0.35,
  neutral: 0,
  hi: 0.35,
} as const

// ── Factor 5: Transfer activity (30d velocity / 3m-avg velocity) ──────────
// 1.0 = current velocity equals 3-month average = neutral signal.
// Calibrated: 0.0 → 0,  1.0 → 50,  3.0 → 100
export const TRANSFER_ACTIVITY_RANGE: FactorRange = {
  lo: 0,
  neutral: 1.0,
  hi: 3.0,
} as const

// ── Factor 6: Breadth (live_products + distinct_chains) ───────────────────
// v1 is Ethereum-only (1 chain), so breadth = live_product_count + 1.
// Max = 5 products + 1 chain = 6.  Simple linear; no semantic neutral.
// Calibrated: 1 → 0,  6 → 100
export const BREADTH_RANGE: FactorRange = {
  lo: 1,
  hi: 6,
} as const

export const METHODOLOGY_VERSION = '1.0'
