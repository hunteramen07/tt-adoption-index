import { cacheLife, cacheTag } from 'next/cache'
import { getSupabase } from '@/src/lib/supabase/client'
import type { BehavioralMix } from '@/src/lib/classify/types'

export interface ProductBehaviorStats {
  productSlug: string
  holderCount: number
  mix: BehavioralMix
  /** Percentage 0–100 */
  dormancySharePct: number
  netNewWallets90d: number
  exitedWallets90d: number
  netAccumulationRatio: number | null
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
      'product_slug, holder_count, behavior_accumulating, behavior_distributing, behavior_dormant, behavior_active, dormancy_share_pct, net_new_wallets_90d, exited_wallets_90d, net_accumulation_ratio, classified_at'
    )

  if (error || !data) return []
  return data.map(rowToStats)
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
      'product_slug, holder_count, behavior_accumulating, behavior_distributing, behavior_dormant, behavior_active, dormancy_share_pct, net_new_wallets_90d, exited_wallets_90d, net_accumulation_ratio, classified_at'
    )
    .eq('product_slug', productSlug)
    .maybeSingle()

  if (error || !data) return null
  return rowToStats(data)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToStats(row: Record<string, any>): ProductBehaviorStats {
  const accumulating = (row.behavior_accumulating as number) ?? 0
  const distributing = (row.behavior_distributing as number) ?? 0
  const dormant = (row.behavior_dormant as number) ?? 0
  const active = (row.behavior_active as number) ?? 0

  return {
    productSlug: row.product_slug as string,
    holderCount: (row.holder_count as number) ?? 0,
    mix: { accumulating, distributing, dormant, active, total: accumulating + distributing + dormant + active },
    dormancySharePct: (row.dormancy_share_pct as number) ?? 0,
    netNewWallets90d: (row.net_new_wallets_90d as number) ?? 0,
    exitedWallets90d: (row.exited_wallets_90d as number) ?? 0,
    netAccumulationRatio: row.net_accumulation_ratio as number | null,
    classifiedAt: row.classified_at as string,
  }
}

/**
 * Top N holders by balance for a product, read from holder_classifications.
 * Share of supply is computed from the sum of all classified holder balances.
 * Returns [] for aggregate-only products (e.g. USDY) which have no per-wallet rows.
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
