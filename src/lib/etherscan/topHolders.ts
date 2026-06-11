import { fetchHolderStats } from './holders'
import type { TopHoldersData } from './types'
import type { Product } from '@/src/config/products'

/**
 * Top-10 holders with share of supply, derived from on-chain transfer history.
 *
 * Delegates to fetchHolderStats which does the actual fetch + computation
 * and carries the `use cache` annotation. This wrapper exists so UI code
 * can import a focused function without needing the full HolderStatsData.
 */
export async function fetchTopHolders(
  product: Product,
  options: { maxTransferPages?: number } = {}
): Promise<TopHoldersData> {
  const stats = await fetchHolderStats(product, options)
  return {
    productSlug: stats.productSlug,
    totalSupplyRaw: stats.totalSupplyRaw,
    decimals: stats.decimals,
    holders: stats.topHolders,
    fetchedAt: stats.fetchedAt,
  }
}
