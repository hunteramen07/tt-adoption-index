import { cacheLife, cacheTag } from 'next/cache'
import { ACTIVE_PRODUCTS } from '@/src/config/products'
import type { Product } from '@/src/config/products'
import { fetchTransferHistory } from '@/src/lib/etherscan/transfers'
import { computeAggregateStats } from '@/src/lib/classify/engine'
import type { BehavioralMix } from '@/src/lib/classify/types'

export interface ProductBehaviorData {
  productSlug: string
  productName: string
  productSymbol: string
  holderCount: number
  mix: BehavioralMix
  dormancySharePct: number
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
  cacheTag('etherscan-data')
  cacheLife('hours')

  try {
    const results = await Promise.all(ACTIVE_PRODUCTS.map(fetchProductBehavior))
    const products = results.filter((r): r is ProductBehaviorData => r !== null)
    return { products, fetchedAt: new Date().toISOString() }
  } catch {
    return null
  }
}

async function fetchProductBehavior(product: Product): Promise<ProductBehaviorData | null> {
  try {
    const transferData = await fetchTransferHistory(product)
    const nowTs = Math.floor(Date.now() / 1000)
    const agg = computeAggregateStats(transferData.transfers, nowTs)

    return {
      productSlug: product.slug,
      productName: product.name,
      productSymbol: product.symbol,
      holderCount: agg.holderCount,
      mix: agg.mix,
      dormancySharePct: agg.dormancySharePct,
      netNewWallets90d: agg.netNewWallets90d,
      exitedWallets90d: agg.exitedWallets90d,
      netAccumulationRatio: agg.netAccumulationRatio,
      isAggregateOnly: product.aggregateFlowsOnly ?? false,
      fetchedAt: transferData.fetchedAt,
    }
  } catch {
    return null
  }
}
