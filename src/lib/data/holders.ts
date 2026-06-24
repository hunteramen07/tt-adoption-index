import { cacheLife, cacheTag } from 'next/cache'
import { ACTIVE_PRODUCTS } from '@/src/config/products'
import { fetchAllAggregateStats } from './classifications'
import type { BehavioralMix } from '@/src/lib/classify/types'

export interface ProductBehaviorData {
  productSlug: string
  productName: string
  productSymbol: string
  holderCount: number
  mix: BehavioralMix
  /** Percentage 0–100, or null when supply-weighted dormancy can't be computed
   *  (multi-chain fund; per-network supply not captured yet — Phase 2). */
  dormancySharePct: number | null
  netNewWallets90d: number
  exitedWallets90d: number
  netAccumulationRatio: number | null
  isAggregateOnly: boolean
  fetchedAt: string
}

export interface HoldersResult {
  products: ProductBehaviorData[]
  fetchedAt: string
}

export async function fetchHoldersBehavior(): Promise<HoldersResult | null> {
  'use cache'
  cacheTag('supabase-classifications')
  cacheLife('hours')

  try {
    const allStats = await fetchAllAggregateStats()
    if (allStats.length === 0) return null

    const bySlug = new Map(allStats.map((s) => [s.productSlug, s]))
    const products: ProductBehaviorData[] = []

    for (const product of ACTIVE_PRODUCTS) {
      const stats = bySlug.get(product.slug)
      if (!stats) continue
      products.push({
        productSlug: product.slug,
        productName: product.name,
        productSymbol: product.symbol,
        holderCount: stats.holderCount,
        mix: stats.mix,
        dormancySharePct: stats.dormancySharePct,
        netNewWallets90d: stats.netNewWallets90d,
        exitedWallets90d: stats.exitedWallets90d,
        netAccumulationRatio: stats.netAccumulationRatio,
        isAggregateOnly: product.aggregateFlowsOnly ?? false,
        fetchedAt: stats.classifiedAt,
      })
    }

    if (products.length === 0) return null

    const latestAt = allStats.map((s) => s.classifiedAt).sort().at(-1) ?? new Date().toISOString()
    return { products, fetchedAt: latestAt }
  } catch {
    return null
  }
}
