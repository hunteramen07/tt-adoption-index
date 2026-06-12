import { cacheLife, cacheTag } from 'next/cache'
import type { Product } from '@/src/config/products'
import { fetchTransferHistory } from '@/src/lib/etherscan/transfers'
import { fetchTotalSupply } from '@/src/lib/etherscan/holders'
import { computeBalances, deriveHolderStats } from '@/src/lib/etherscan/balances'
import {
  classifyHolders,
  computeDormancySharePct,
  computeAggregateStats,
} from '@/src/lib/classify/engine'

export interface ProductStats {
  productSlug: string
  holderCount: number
  /** Fraction 0–1: combined share of top-5 holders */
  top5Share: number
  /** Fraction 0–1: supply with no outbound transfer in trailing 90d */
  dormancyShare: number
  fetchedAt: string
}

/**
 * Fetches holder count, top-5 share, and dormancy share for a single product.
 * Wraps the full transfer-history replay + classify pipeline in a `use cache`
 * boundary so the expensive work only runs once per cache TTL.
 */
export async function fetchProductStats(
  product: Product
): Promise<ProductStats | null> {
  'use cache'
  cacheTag('etherscan-data')
  cacheLife('hours')

  try {
    const [transferData, totalSupplyRaw] = await Promise.all([
      fetchTransferHistory(product),
      fetchTotalSupply(product.contractAddress),
    ])

    // Compute implied supply from transfer history as a resilient fallback.
    // If Etherscan tokensupply fails (rate-limit, network error), using '0'
    // would make every holder appear to hold 0% of supply and cache a corrupt
    // result for the cache TTL.
    const balances = computeBalances(transferData.transfers)
    const impliedSupply = [...balances.values()]
      .reduce((s, v) => s + v, BigInt(0))
      .toString()
    const supply = totalSupplyRaw ?? impliedSupply

    const { holderCount, topHolders } = deriveHolderStats(
      transferData.transfers,
      supply,
      product.decimals,
      product.slug,
      10
    )

    const top5Share =
      topHolders.slice(0, 5).reduce((sum, h) => sum + h.shareOfSupply, 0) / 100

    const nowTs = Math.floor(Date.now() / 1000)
    let dormancyShare: number

    if (product.aggregateFlowsOnly) {
      const agg = computeAggregateStats(transferData.transfers, nowTs)
      dormancyShare = agg.dormancySharePct / 100
    } else {
      const classifications = classifyHolders(transferData.transfers, nowTs)
      dormancyShare = computeDormancySharePct(classifications) / 100
    }

    return {
      productSlug: product.slug,
      holderCount,
      top5Share,
      dormancyShare,
      fetchedAt: transferData.fetchedAt,
    }
  } catch {
    return null
  }
}
