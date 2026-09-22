/**
 * NAV tripwires — the two traps left after "missing navUsd throws" (commit ab1fecf,
 * 2026-06-15, the USTB 11× understatement).
 *
 * NAVs are hardcoded in products.ts with a navAsOf date and refreshed by hand. Two
 * ways that silently goes wrong:
 *   • STALENESS — nobody refreshes. An accruing fund's price drifts up ~4-5%/yr, so a
 *     NAV a quarter old understates AUM by ~1%, and a year old by ~5%. Every NAV was
 *     last verified 2026-07-22; warn past NAV_STALE_DAYS.
 *   • DRIFT — the hardcoded figure disagrees with the market. rwa.xyz's /v4/assets
 *     reports a dollar value per network alongside supply, so Σ value / Σ supply is
 *     an implied price the nightly already has for free. Warn past NAV_DRIFT_PCT.
 *     rwa.xyz reports NO dollar value for some funds (BUIDL, USTB come back 0), so
 *     the check skips those explicitly — a zero must never read as a price.
 *
 * Both are pure; the caller logs, annotates and persists (reconciliation_history,
 * outcomes 'nav_stale' / 'nav_drift', network 'all', deviation_pct = age in days /
 * drift in percent, threshold_pct = the threshold that applied).
 */

import type { Product } from '@/src/config/products'
import type { RwaAssetToken } from '@/src/lib/rwa/assets'

/** Days since navAsOf beyond which the NAV is reported stale. */
export const NAV_STALE_DAYS = 45
/** |implied − config| / config, percent, beyond which the NAV is reported drifted. */
export const NAV_DRIFT_PCT = 2

const DAY_MS = 86_400_000

export interface NavStalenessResult {
  stale: boolean
  ageDays: number | null
  reason: string
}

/** Pure. A product with no navAsOf cannot be aged and is reported as such (stale). */
export function evaluateNavStaleness(product: Pick<Product, 'slug' | 'navAsOf'>, nowMs: number, staleDays = NAV_STALE_DAYS): NavStalenessResult {
  if (!product.navAsOf) return { stale: true, ageDays: null, reason: 'no navAsOf date — the NAV has no recorded verification' }
  const ms = Date.parse(`${product.navAsOf}T00:00:00Z`)
  if (!Number.isFinite(ms)) return { stale: true, ageDays: null, reason: `unparseable navAsOf ${product.navAsOf}` }
  const ageDays = Math.max(0, (nowMs - ms) / DAY_MS)
  return ageDays > staleDays
    ? { stale: true, ageDays, reason: `NAV verified ${product.navAsOf}, ${ageDays.toFixed(0)} days ago (> ${staleDays})` }
    : { stale: false, ageDays, reason: `NAV verified ${product.navAsOf}, ${ageDays.toFixed(0)} days ago` }
}

export interface NavDriftResult {
  outcome: 'ok' | 'drift' | 'skipped_no_value'
  /** Σ dollar value / Σ supply over the networks rwa.xyz prices; null when skipped. */
  impliedNav: number | null
  configNav: number
  driftPct: number | null
  /** Networks that contributed a dollar value. */
  networksUsed: number
  supplyTokens: number
  reason: string
}

/** Pure. Uses only tokens with BOTH a positive dollar value and positive supply. */
export function evaluateNavDrift(
  product: Pick<Product, 'slug'> & { navUsd: number },
  tokens: readonly RwaAssetToken[],
  driftPct = NAV_DRIFT_PCT
): NavDriftResult {
  let value = 0
  let supply = 0
  let networksUsed = 0
  for (const t of tokens) {
    const v = t.market_value_dollar?.val ?? null
    const s = t.total_supply_token?.val ?? null
    if (v == null || s == null || v <= 0 || s <= 0) continue
    value += v
    supply += s
    networksUsed++
  }
  const configNav = product.navUsd
  if (networksUsed === 0 || supply <= 0) {
    return { outcome: 'skipped_no_value', impliedNav: null, configNav, driftPct: null, networksUsed: 0, supplyTokens: supply, reason: 'rwa.xyz reports no dollar value for this fund — implied price unavailable' }
  }
  const impliedNav = value / supply
  const drift = ((impliedNav - configNav) / configNav) * 100
  const summary = `config $${configNav} vs rwa.xyz-implied $${impliedNav.toFixed(4)} (${drift >= 0 ? '+' : ''}${drift.toFixed(2)}% over ${networksUsed} network(s))`
  return Math.abs(drift) > driftPct
    ? { outcome: 'drift', impliedNav, configNav, driftPct: drift, networksUsed, supplyTokens: supply, reason: `${summary} — beyond ${driftPct}%` }
    : { outcome: 'ok', impliedNav, configNav, driftPct: drift, networksUsed, supplyTokens: supply, reason: summary }
}
