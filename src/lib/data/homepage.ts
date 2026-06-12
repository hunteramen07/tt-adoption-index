import { cacheLife, cacheTag } from 'next/cache'
import type { Product } from '@/src/config/products'
import { fetchProductAggregate, fetchTopHoldersFromDb } from './classifications'

export interface ProductStats {
  productSlug: string
  holderCount: number
  /** Percentage shares of top holders, sorted desc. Length ≤ 10. */
  topHolderShares: number[]
  /** Fraction 0–1 */
  dormancyShare: number
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
      dormancyShare: agg.dormancySharePct / 100,
      classifiedAt: agg.classifiedAt,
    }
  } catch {
    return null
  }
}
