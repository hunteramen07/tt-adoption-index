export interface FactorInputs {
  readingDate: string // YYYY-MM-DD (last day of month)

  // Factor 1: 3-month % change in total NAV-aware AUM across all products
  aumGrowth3m?: number

  // Factor 2: 3-month % change in total distinct holder count
  holderGrowth3m?: number

  // Factor 3: 3-month change in average top-5 holder share across products.
  // Positive = concentration increased (bad); negative = decreased (good).
  // compute.ts negates this before normalizing.
  concentrationDelta3m?: number

  // Factor 4: 3-month change in average dormancy share across products.
  // Positive = more dormant supply (bad); negative = less dormant (good).
  // compute.ts negates this before normalizing.
  dormancyDelta3m?: number

  // Factor 5: (30-day transfer velocity) / (3-month average velocity).
  // velocity = non-mint/burn transfer volume (USD) / AUM.
  // 1.0 = at average; undefined when <3 months of prior velocity data exist.
  transferActivityRatio?: number

  // Factor 6: live_product_count + distinct_chain_count at reading date.
  breadth?: number
}

export interface FactorScore {
  /** The raw input value passed to normalizeScore */
  raw: number
  /** Normalized score 0–100 */
  score: number
}

export interface IndexReading {
  readingDate: string // YYYY-MM-DD
  /** Weighted arithmetic mean of available factor scores, 0–100 */
  composite: number
  factors: {
    aumGrowth3m?: FactorScore
    holderGrowth3m?: FactorScore
    concentrationDelta3m?: FactorScore
    dormancyDelta3m?: FactorScore
    transferActivityRatio?: FactorScore
    breadth?: FactorScore
  }
  /** True when one or more factors could not be computed */
  isPartial: boolean
  /** Human-readable description of which factors are missing and why */
  partialReason: string | null
  methodologyVersion: string
}

export interface ProductSnapshot {
  snapshotDate: string       // YYYY-MM-DD
  product: string            // product slug
  aum: number                // USD (supply × current hardcoded NAV)
  holderCount: number        // distinct addresses with positive balance
  top5Share: number          // fraction 0–1 (top-5 holder supply / total supply)
  dormancyShare: number      // fraction 0–1 (supply with no outbound in trailing 90d)
  transferVolume30d: number  // USD, non-mint/burn transfers in trailing 30d
}
