/**
 * Supply-reconciliation tripwire — the pure evaluation, and the append-only
 * `reconciliation_history` row it persists.
 *
 * WHAT IT CHECKS. |Σ positive holder balances − ON-CHAIN supply| / chain supply.
 * The holder state is what every derived metric (holder_count, dormancy,
 * concentration) is computed from, so its divergence from an independent reference
 * is a direct corruption signal for those metrics. The reference is CHAIN supply
 * (chain-supply.ts), never /v4/assets: /v4/assets is served from the same rwa.xyz
 * ledger the state is replayed from, so reconciling against it is tautological — it
 * passed while buidl:solana sat 4.66% below chain and ustb:solana 13.69% above.
 *
 * OUTCOMES (every one is logged AND persisted — a passing tripwire that writes
 * nothing and a failing one that scrolls off a CI log are equally invisible):
 *   pass                      deviation ≤ threshold
 *   warn                      deviation > threshold (RECONCILE_STRICT=1 makes it fatal)
 *   skipped_no_reference      network has no chain reference — SKIP, never fall back
 *   skipped_reference_failed  reference read threw (RPC down / decimals mismatch)
 *   skipped_degenerate        chain supply ≤ 0 — a zero denominator says nothing
 *   skipped_dust              notional (chain supply × NAV) below the $1M floor — a
 *                             dust deployment swings wildly in % on rounding alone
 *
 * Negative balances are reported alongside, unconditionally (no threshold, no
 * floor): a wallet cannot hold less than zero on-chain, so a negative means
 * transfers landed on mismatched address keys. They never trip strict mode — the
 * known residuals (rwa.xyz source holes, e.g. buidl:solana FeVg63wv…) would block
 * otherwise-good networks every night.
 *
 * ASSETS-VS-CHAIN DELTA. Informational, zero-threshold: (/v4/assets − chain) / chain.
 * That is rwa.xyz's own indexing gap, independent of our state — the number the
 * data-quality list in _local/STATUS.md is built from. Logged and persisted with
 * every row so it can be charted, never acted on.
 */

import { getSupabase } from '@/src/lib/supabase/client'
import type { ChainSupply } from '@/src/lib/rwa/chain-supply'

/** Deviation above which the state/chain mismatch is reported. */
export const RECONCILE_WARN_PCT = 3
/** Notional floor (chain supply × NAV) below which the % check is skipped, logged. */
export const RECONCILE_MIN_NOTIONAL_USD = 1_000_000

export type ReconcileOutcome =
  | 'pass'
  | 'warn'
  | 'skipped_no_reference'
  | 'skipped_reference_failed'
  | 'skipped_degenerate'
  | 'skipped_dust'

export interface ReconcileInput {
  /** Σ positive holder balances, in whole tokens. */
  stateTokens: number
  holderCount: number
  negativeCount: number
  /** null = the network has no chain reference (or the read failed, see chainError). */
  chain: ChainSupply | null
  /** Set when the reference read threw; distinguishes "none" from "down this run". */
  chainError?: string | null
  /** /v4/assets supply for the informational delta; null when unavailable. */
  assetsSupplyTokens: number | null
  navUsd: number
  thresholdPct?: number
  minNotionalUsd?: number
}

export interface ReconcileResult {
  outcome: ReconcileOutcome
  /** |state − chain| / chain × 100; null whenever skipped. */
  deviationPct: number | null
  /** state / chain; null whenever skipped. */
  ratio: number | null
  /** chain supply × NAV; null without a usable reference. */
  notionalUsd: number | null
  /** (/v4/assets − chain) / chain × 100; null unless both are present and chain > 0. */
  assetsDeltaPct: number | null
  thresholdPct: number
}

/** Pure — no I/O, no logging. Everything the caller logs or persists comes from here. */
export function evaluateReconciliation(input: ReconcileInput): ReconcileResult {
  const thresholdPct = input.thresholdPct ?? RECONCILE_WARN_PCT
  const minNotionalUsd = input.minNotionalUsd ?? RECONCILE_MIN_NOTIONAL_USD
  const base: ReconcileResult = {
    outcome: 'skipped_no_reference',
    deviationPct: null,
    ratio: null,
    notionalUsd: null,
    assetsDeltaPct: null,
    thresholdPct,
  }

  if (input.chainError) return { ...base, outcome: 'skipped_reference_failed' }
  if (!input.chain) return base

  const chain = input.chain.supplyTokens
  if (chain <= 0) return { ...base, outcome: 'skipped_degenerate' }

  const assetsDeltaPct =
    input.assetsSupplyTokens == null ? null : ((input.assetsSupplyTokens - chain) / chain) * 100
  const notionalUsd = chain * input.navUsd
  const deviationPct = (Math.abs(input.stateTokens - chain) / chain) * 100
  const ratio = input.stateTokens / chain

  if (notionalUsd < minNotionalUsd) {
    // Deviation is still reported (in the log and the row) so a dust skip is
    // inspectable — it just does not warn.
    return { ...base, outcome: 'skipped_dust', deviationPct, ratio, notionalUsd, assetsDeltaPct }
  }
  return {
    ...base,
    outcome: deviationPct > thresholdPct ? 'warn' : 'pass',
    deviationPct,
    ratio,
    notionalUsd,
    assetsDeltaPct,
  }
}

/** True when RECONCILE_STRICT=1: a `warn` outcome throws instead of just logging. */
export const isReconcileStrict = (): boolean => process.env.RECONCILE_STRICT?.trim() === '1'

/** One append-only observation. Column names match the migration exactly. */
export interface ReconciliationHistoryRow {
  product_slug: string
  network: string
  /** 'classify' (nightly incremental) or 'reanchor' (post-swap check). */
  context: 'classify' | 'reanchor'
  outcome: ReconcileOutcome
  reference: ChainSupply['reference'] | null
  state_tokens: number
  holder_count: number
  negative_count: number
  chain_supply_tokens: number | null
  assets_supply_tokens: number | null
  deviation_pct: number | null
  assets_delta_pct: number | null
  notional_usd: number | null
  threshold_pct: number
  strict: boolean
}

/**
 * INSERT one row (never upsert — every run accumulates, like behavior_history).
 * Throws on a Supabase error; the caller downgrades that to a warning, because the
 * table is applied by hand and a missing table must never fail a classify run.
 */
export async function insertReconciliationHistory(row: ReconciliationHistoryRow): Promise<void> {
  const { error } = await getSupabase().from('reconciliation_history').insert(row)
  if (error) throw new Error(`reconciliation_history insert failed (${row.product_slug}/${row.network}): ${error.message}`)
}
