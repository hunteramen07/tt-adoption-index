export type BehaviorLabel = 'Accumulating' | 'Distributing' | 'Dormant' | 'Active'

export interface HolderClassification {
  address: string
  behavior: BehaviorLabel
  /** Current balance in raw token units (string to safely carry BigInt) */
  balanceRaw: string
  /** Tokens received in the trailing 90-day window (raw units) */
  inflowRaw: string
  /** Tokens sent in the trailing 90-day window (raw units) */
  outflowRaw: string
  isLabeledCustodian: boolean
  nameTag: string | null
}

export interface BehavioralMix {
  accumulating: number
  distributing: number
  dormant: number
  active: number
  total: number
}

export interface ProductClassificationSummary {
  productSlug: string
  mix: BehavioralMix
  /** % of total supply held by addresses with no outbound in the window.
   *  This is the Dormancy factor input: includes both Dormant + Accumulating. */
  dormancySharePct: number
  asOfBlock: number
  classifiedAt: string
}

export interface UsdyAggregateStats {
  productSlug: string
  holderCount: number
  mix: BehavioralMix
  dormancySharePct: number
  netNewWallets90d: number
  exitedWallets90d: number
  /** Accumulating / (Accumulating + Distributing); null when both are zero */
  netAccumulationRatio: number | null
  asOfBlock: number
  classifiedAt: string
}
