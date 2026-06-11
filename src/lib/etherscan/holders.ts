import { cacheLife, cacheTag } from 'next/cache'
import { etherscanGet } from './client'
import { fetchTransferHistory } from './transfers'
import { deriveHolderStats } from './balances'
import type { HolderCountData, EnrichedHolder } from './types'
import type { Product } from '@/src/config/products'

/**
 * Total token supply in raw units (no decimal adjustment).
 * Cached 1 hour per contract address.
 */
export async function fetchTotalSupply(
  contractAddress: string
): Promise<string | null> {
  'use cache'
  cacheTag('etherscan-data')
  cacheLife('hours')

  return etherscanGet<string>({
    module: 'stats',
    action: 'tokensupply',
    contractaddress: contractAddress,
  })
}

export interface HolderStatsData {
  productSlug: string
  holderCount: number
  totalSupplyRaw: string
  decimals: number
  /** Top-10 holders derived from on-chain transfer history */
  topHolders: EnrichedHolder[]
  /** Highest block number included in the transfer history used */
  derivedFromBlock: number
  fetchedAt: string
}

/**
 * Computes holder count and top-10 holders by replaying the full on-chain
 * transfer history. This is the free-tier alternative to the Pro-only
 * tokenholdercount / tokenholderlist Etherscan endpoints.
 *
 * The transfer history is disk-cached and fetched incrementally; this
 * function adds a 1-hour in-memory cache on top via `use cache`.
 *
 * @param options.maxTransferPages  Passed through to fetchTransferHistory.
 *   Defaults to Infinity (full history). Set small for the debug endpoint.
 */
export async function fetchHolderStats(
  product: Product,
  options: { maxTransferPages?: number } = {}
): Promise<HolderStatsData> {
  'use cache'
  cacheTag('etherscan-data')
  cacheLife('hours')

  const [transferData, totalSupplyRaw] = await Promise.all([
    fetchTransferHistory(product, { maxPages: options.maxTransferPages }),
    fetchTotalSupply(product.contractAddress),
  ])

  const supply = totalSupplyRaw ?? '0'
  const { holderCount, topHolders } = deriveHolderStats(
    transferData.transfers,
    supply,
    product.decimals,
    product.slug
  )

  return {
    productSlug: product.slug,
    holderCount,
    totalSupplyRaw: supply,
    decimals: product.decimals,
    topHolders,
    derivedFromBlock: transferData.lastBlock,
    fetchedAt: new Date().toISOString(),
  }
}

/** Thin wrapper — returns just the holder count. */
export async function fetchHolderCount(product: Product): Promise<HolderCountData> {
  const stats = await fetchHolderStats(product)
  return {
    productSlug: stats.productSlug,
    holderCount: stats.holderCount,
    fetchedAt: stats.fetchedAt,
  }
}
