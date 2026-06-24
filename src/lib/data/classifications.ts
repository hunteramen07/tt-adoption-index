import { cacheLife, cacheTag } from 'next/cache'
import { getSupabase } from '@/src/lib/supabase/client'
import type { BehavioralMix } from '@/src/lib/classify/types'

export interface ProductBehaviorStats {
  productSlug: string
  /** Summed across the fund's networks (positions; NOT cross-chain-deduped). */
  holderCount: number
  mix: BehavioralMix
  /**
   * Percentage 0–100, or null when it cannot be computed honestly. Dormancy is
   * SUPPLY-WEIGHTED, which needs per-network supply we do not capture yet
   * (Phase 2). So it is reported only for single-network funds and is null for
   * multi-chain funds (networkCount > 1). Render a "pending" placeholder for null
   * — do NOT substitute a holder-count-weighted or single-arbitrary-chain value.
   */
  dormancySharePct: number | null
  netNewWallets90d: number
  exitedWallets90d: number
  netAccumulationRatio: number | null
  /** Number of per-network rows summed (1 ⇒ single-chain fund). */
  networkCount: number
  classifiedAt: string
}

export interface DbTopHolder {
  address: string
  nameTag: string | null
  /** Percentage, e.g. 23.5 */
  shareOfSupply: number
  balanceFormatted: string
}

export async function fetchAllAggregateStats(): Promise<ProductBehaviorStats[]> {
  'use cache'
  cacheTag('supabase-classifications')
  cacheLife('hours')

  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('holder_aggregate_stats')
    .select(
      'product_slug, holder_count, behavior_accumulating, behavior_distributing, behavior_dormant, behavior_active, dormancy_share_pct, net_new_wallets_90d, exited_wallets_90d, net_accumulation_ratio, market_value_usd, classified_at'
    )

  if (error || !data) return []
  // Group the per-(product, network) rows by fund, then aggregate across networks
  // (was a Map keyed by slug downstream, where the last network arbitrarily won).
  const byFund = new Map<string, Array<Record<string, unknown>>>()
  for (const row of data) {
    const slug = row.product_slug as string
    const arr = byFund.get(slug) ?? []
    arr.push(row)
    byFund.set(slug, arr)
  }
  return Array.from(byFund.values()).map(aggregateRows)
}

export async function fetchProductAggregate(
  productSlug: string
): Promise<ProductBehaviorStats | null> {
  'use cache'
  cacheTag('supabase-classifications')
  cacheLife('hours')

  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('holder_aggregate_stats')
    .select(
      'product_slug, holder_count, behavior_accumulating, behavior_distributing, behavior_dormant, behavior_active, dormancy_share_pct, net_new_wallets_90d, exited_wallets_90d, net_accumulation_ratio, market_value_usd, classified_at'
    )
    .eq('product_slug', productSlug)

  // Was .maybeSingle(), which ERRORED on multi-chain funds (>1 network row) →
  // null cards for BUIDL/USTB/USYC. Fetch all network rows and aggregate.
  if (error || !data || data.length === 0) return null
  return aggregateRows(data)
}

/**
 * Aggregate a fund's per-network holder_aggregate_stats rows into one object.
 * Counts (holders, behavioral mix, net-new/exited) are SUMMED — per the
 * multi-chain methodology these are positions summed across chains, NOT
 * cross-chain-deduplicated entities. netAccumulationRatio is a count ratio, so it
 * is recomputed from the summed mix. dormancy is supply-weighted and we do not yet
 * capture per-network supply (Phase 2), so it is reported only for single-network
 * funds and null for multi-chain ones — callers render a "pending" placeholder,
 * never a wrong number.
 */
function aggregateRows(rows: Array<Record<string, unknown>>): ProductBehaviorStats {
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  // numeric columns may arrive as number or decimal-string; parse defensively.
  const parseNum = (v: unknown): number | null => {
    if (typeof v === 'number') return isFinite(v) ? v : null
    if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return isFinite(n) ? n : null }
    return null
  }
  let holderCount = 0, accumulating = 0, distributing = 0, dormant = 0, active = 0
  let netNew = 0, exited = 0, classifiedAt = ''
  for (const r of rows) {
    holderCount += num(r.holder_count)
    accumulating += num(r.behavior_accumulating)
    distributing += num(r.behavior_distributing)
    dormant += num(r.behavior_dormant)
    active += num(r.behavior_active)
    netNew += num(r.net_new_wallets_90d)
    exited += num(r.exited_wallets_90d)
    const ca = (r.classified_at as string) ?? ''
    if (ca > classifiedAt) classifiedAt = ca
  }
  const networkCount = rows.length

  // Dormancy is supply-weighted. Single-network ⇒ that one network's value is valid
  // as-is. Multi-network ⇒ Σ(dormancy% × market_value_usd) / Σ(market_value_usd)
  // (Phase 2a), but ONLY when EVERY network row has a non-null market value — if any
  // is missing, stay "pending" (null) rather than report a partial-data number.
  let dormancySharePct: number | null
  if (networkCount === 1) {
    dormancySharePct = num(rows[0].dormancy_share_pct)
  } else {
    const mvs = rows.map((r) => parseNum(r.market_value_usd))
    if (mvs.every((v) => v !== null)) {
      let weighted = 0, mvTotal = 0
      for (let i = 0; i < rows.length; i++) {
        weighted += num(rows[i].dormancy_share_pct) * (mvs[i] as number)
        mvTotal += mvs[i] as number
      }
      dormancySharePct = mvTotal > 0 ? weighted / mvTotal : null
    } else {
      dormancySharePct = null // pending: some network lacks market_value_usd yet
    }
  }

  return {
    productSlug: rows[0].product_slug as string,
    holderCount,
    mix: { accumulating, distributing, dormant, active, total: accumulating + distributing + dormant + active },
    dormancySharePct,
    netNewWallets90d: netNew,
    exitedWallets90d: exited,
    netAccumulationRatio:
      accumulating + distributing > 0 ? accumulating / (accumulating + distributing) : null,
    networkCount,
    classifiedAt,
  }
}

/**
 * Top N holders by balance for a product, read from holder_classifications.
 * Share of supply is computed from the sum of all classified holder balances.
 * Returns [] for aggregate-only products (e.g. USDY) which have no per-wallet rows.
 *
 * PHASE 1 INTERIM (multi-chain): scoped to the ETHEREUM slice only. The current
 * share math (sum balance_raw / classified total) is not valid across chains —
 * per-network decimals are non-additive (raw integers at different scales), and
 * pooling base58 + 0x addresses into one "top holders" list mixes chains with no
 * real cross-chain supply denominator. Rather than silently surface a misleading
 * mixed-chain top-10, we restrict to Ethereum (a coherent single chain, as it was
 * pre-migration). PHASE 2: per-network top holders weighted by per-network supply
 * (the same per-network-supply capture that unblocks supply-weighted dormancy).
 */
export async function fetchTopHoldersFromDb(
  productSlug: string,
  decimals: number,
  limit = 10
): Promise<DbTopHolder[]> {
  'use cache'
  cacheTag('supabase-classifications')
  cacheLife('hours')

  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('holder_classifications')
    .select('address, name_tag, balance_raw')
    .eq('product_slug', productSlug)
    .eq('network', 'ethereum') // PHASE 1: Ethereum-only (see fn doc) — Phase 2 makes this per-network

  if (error || !data || data.length === 0) return []

  const divisor = BigInt(10) ** BigInt(decimals)

  const sorted = [...data].sort((a, b) => {
    const bA = safeBigInt(a.balance_raw)
    const bB = safeBigInt(b.balance_raw)
    return bB > bA ? 1 : bB < bA ? -1 : 0
  })

  let totalRaw = BigInt(0)
  for (const h of data) totalRaw += safeBigInt(h.balance_raw)

  return sorted.slice(0, limit).map((h) => {
    const balanceRaw = safeBigInt(h.balance_raw)
    const shareOfSupply =
      totalRaw > BigInt(0)
        ? Number((balanceRaw * BigInt(10000)) / totalRaw) / 100
        : 0
    const balanceTokens = Number(balanceRaw / divisor)

    return {
      address: h.address as string,
      nameTag: (h.name_tag as string | null) ?? null,
      shareOfSupply,
      balanceFormatted: fmtTokens(balanceTokens),
    }
  })
}

function safeBigInt(val: string | null | undefined): bigint {
  if (!val) return BigInt(0)
  try {
    return BigInt(val)
  } catch {
    return BigInt(0)
  }
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}
