import { cacheLife, cacheTag } from 'next/cache'
import type { Product } from '@/src/config/products'
import { fetchProductAggregate, fetchTopHoldersFromDb } from './classifications'

export interface ProductStats {
  productSlug: string
  holderCount: number
  /** Percentage shares of top holders, sorted desc. Length ≤ 10. */
  topHolderShares: number[]
  /** Fraction 0–1, or null when supply-weighted dormancy can't be computed yet
   *  (multi-chain fund; per-network supply not captured — Phase 2). */
  dormancyShare: number | null
  classifiedAt: string | null
}

export async function fetchProductStats(product: Product): Promise<ProductStats | null> {
  'use cache'
  cacheTag('supabase-classifications')
  cacheLife('hours')

  try {
    const [agg, topHolders] = await Promise.all([
      fetchProductAggregate(product.slug),
      product.aggregateFlowsOnly
        ? Promise.resolve([])
        : fetchTopHoldersFromDb(product.slug, product.decimals, 10),
    ])

    if (!agg) return null

    return {
      productSlug: product.slug,
      holderCount: agg.holderCount,
      topHolderShares: topHolders.map((h) => h.shareOfSupply),
      // null (multi-chain, pending) stays null — don't coerce (null/100 === 0).
      dormancyShare: agg.dormancySharePct === null ? null : agg.dormancySharePct / 100,
      classifiedAt: agg.classifiedAt,
    }
  } catch {
    return null
  }
}
