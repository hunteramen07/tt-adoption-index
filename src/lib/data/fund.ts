import { cacheLife, cacheTag } from 'next/cache'
import { PRODUCTS_BY_SLUG, getNavUsd } from '@/src/config/products'
import type { ProductSlug } from '@/src/config/products'
import { etherscanGet } from '@/src/lib/etherscan/client'
import { fetchNameTags } from '@/src/lib/etherscan/nameTags'
import { fetchAumHistory } from '@/src/lib/dune/supplyHistory'
import { fetchProductAggregate, fetchTopHoldersFromDb } from './classifications'
import type { BehavioralMix } from '@/src/lib/classify/types'
import type { ProductAumHistory } from '@/src/lib/dune/supplyHistory'
import type { ERC20Transfer } from '@/src/lib/etherscan/types'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export interface TopHolder {
  address: string
  nameTag: string | null
  shareOfSupply: number
  balanceFormatted: string
}

export interface LargeTransfer {
  hash: string
  from: string
  fromName: string | null
  to: string
  toName: string | null
  valueUsd: number
  timestamp: number
  isMint: boolean
  isBurn: boolean
}

export interface FundData {
  productSlug: ProductSlug
  productName: string
  productSymbol: string
  issuer: string
  navUsd: number
  navAsOf: string | null
  holderCount: number
  /** Fraction 0–1: combined share of top-5 holders (PHASE 1: Ethereum slice only) */
  top5Share: number
  /** Percentage 0–100, or null when supply-weighted dormancy can't be computed yet
   *  (multi-chain fund; per-network supply not captured — Phase 2). */
  dormancySharePct: number | null
  mix: BehavioralMix
  netNewWallets90d: number
  exitedWallets90d: number
  netAccumulationRatio: number | null
  topHolders: TopHolder[]
  recentLargeTransfers: LargeTransfer[]
  aumHistory: ProductAumHistory | null
  isAggregateOnly: boolean
  /** ISO timestamp of the last classification run */
  fetchedAt: string
}

export async function fetchFundData(slug: ProductSlug): Promise<FundData | null> {
  'use cache'
  cacheTag('supabase-classifications', 'etherscan-data', 'dune-data')
  cacheLife('hours')

  const product = PRODUCTS_BY_SLUG[slug]
  if (!product || product.active === false) return null

  try {
    const [agg, dbHolders, recentLarge, aumResult] = await Promise.all([
      fetchProductAggregate(slug),
      product.aggregateFlowsOnly
        ? Promise.resolve([])
        : fetchTopHoldersFromDb(slug, product.decimals, 10),
      fetchRecentLargeTransfers(
        product.contractAddress,
        getNavUsd(product),
        product.decimals
      ),
      fetchAumHistory(),
    ])

    if (!agg) return null

    const topHolders: TopHolder[] = dbHolders.map((h) => ({
      address: h.address,
      nameTag: h.nameTag,
      shareOfSupply: h.shareOfSupply,
      balanceFormatted: h.balanceFormatted,
    }))

    const top5Share =
      topHolders.slice(0, 5).reduce((sum, h) => sum + h.shareOfSupply, 0) / 100

    return {
      productSlug: slug,
      productName: product.name,
      productSymbol: product.symbol,
      issuer: product.issuer,
      navUsd: getNavUsd(product),
      navAsOf: product.navAsOf ?? null,
      holderCount: agg.holderCount,
      top5Share,
      dormancySharePct: agg.dormancySharePct,
      mix: agg.mix,
      netNewWallets90d: agg.netNewWallets90d,
      exitedWallets90d: agg.exitedWallets90d,
      netAccumulationRatio: agg.netAccumulationRatio,
      topHolders,
      recentLargeTransfers: recentLarge,
      aumHistory: aumResult?.products[slug] ?? null,
      isAggregateOnly: product.aggregateFlowsOnly ?? false,
      fetchedAt: agg.classifiedAt,
    }
  } catch {
    return null
  }
}

/**
 * Fetches the 200 most recent token transfers (sort=desc) and returns those
 * exceeding $1M in value. This is a cheap, bounded Etherscan call — no full
 * history replay needed.
 */
async function fetchRecentLargeTransfers(
  contractAddress: string,
  navUsd: number,
  decimals: number,
  limit = 10
): Promise<LargeTransfer[]> {
  const threshold = (1_000_000 / navUsd) * 10 ** decimals

  const raw = await etherscanGet<ERC20Transfer[]>({
    module: 'account',
    action: 'tokentx',
    contractaddress: contractAddress,
    page: '1',
    offset: '200',
    sort: 'desc',
  })

  if (!raw || raw.length === 0) return []

  const large = raw.filter((t) => parseFloat(t.value) > threshold).slice(0, limit)
  if (large.length === 0) return []

  const addresses = new Set<string>()
  for (const t of large) {
    if (t.from !== ZERO_ADDRESS) addresses.add(t.from.toLowerCase())
    if (t.to !== ZERO_ADDRESS) addresses.add(t.to.toLowerCase())
  }
  const nameTags = await fetchNameTags([...addresses])

  return large.map((t) => ({
    hash: t.hash,
    from: t.from,
    fromName: nameTags[t.from.toLowerCase()]?.nameTag ?? null,
    to: t.to,
    toName: nameTags[t.to.toLowerCase()]?.nameTag ?? null,
    valueUsd: (parseFloat(t.value) / 10 ** decimals) * navUsd,
    timestamp: parseInt(t.timeStamp),
    isMint: t.from === ZERO_ADDRESS,
    isBurn: t.to === ZERO_ADDRESS,
  }))
}
