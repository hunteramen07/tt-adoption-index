import { cacheLife, cacheTag } from 'next/cache'
import { PRODUCTS_BY_SLUG } from '@/src/config/products'
import type { ProductSlug } from '@/src/config/products'
import { fetchTransferHistory } from '@/src/lib/etherscan/transfers'
import { fetchTotalSupply } from '@/src/lib/etherscan/holders'
import { computeBalances, deriveHolderStats } from '@/src/lib/etherscan/balances'
import { computeAggregateStats } from '@/src/lib/classify/engine'
import { fetchNameTags } from '@/src/lib/etherscan/nameTags'
import { fetchAumHistory } from '@/src/lib/dune/supplyHistory'
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
  top5Share: number
  dormancySharePct: number
  mix: BehavioralMix
  netNewWallets90d: number
  exitedWallets90d: number
  netAccumulationRatio: number | null
  topHolders: TopHolder[]
  recentLargeTransfers: LargeTransfer[]
  aumHistory: ProductAumHistory | null
  isAggregateOnly: boolean
  fetchedAt: string
}

export async function fetchFundData(slug: ProductSlug): Promise<FundData | null> {
  'use cache'
  cacheTag('etherscan-data', 'dune-data')
  cacheLife('hours')

  const product = PRODUCTS_BY_SLUG[slug]
  if (!product || product.active === false) return null

  try {
    const [transferData, totalSupplyRaw, aumResult] = await Promise.all([
      fetchTransferHistory(product),
      fetchTotalSupply(product.contractAddress),
      fetchAumHistory(),
    ])

    const navUsd = product.navUsd ?? 1
    const nowTs = Math.floor(Date.now() / 1000)

    // Supply denominator — resilient to API failure
    const balances = computeBalances(transferData.transfers)
    const impliedSupply = [...balances.values()].reduce((s, v) => s + v, BigInt(0)).toString()
    const supply = totalSupplyRaw ?? impliedSupply

    const { holderCount, topHolders: rawTopHolders } = deriveHolderStats(
      transferData.transfers,
      supply,
      product.decimals,
      product.slug,
      10
    )

    const top5Share =
      rawTopHolders.slice(0, 5).reduce((sum, h) => sum + h.shareOfSupply, 0) / 100

    // Name tags for top 10 holders
    const topAddresses = rawTopHolders.map((h) => h.address)
    const nameTags = await fetchNameTags(topAddresses)

    const topHolders: TopHolder[] = rawTopHolders.map((h) => ({
      address: h.address,
      nameTag: nameTags[h.address.toLowerCase()]?.nameTag ?? null,
      shareOfSupply: h.shareOfSupply,
      balanceFormatted: h.balance,
    }))

    // Behavioral mix + dormancy
    const agg = computeAggregateStats(transferData.transfers, nowTs)

    // Recent large transfers (>$1M USD, capped at 10)
    const threshold = 1_000_000 / navUsd * (10 ** product.decimals)
    const allAddressesForNames = new Set<string>()

    const largeTxs = transferData.transfers
      .filter((t) => parseFloat(t.value) > threshold)
      .sort((a, b) => parseInt(b.timeStamp) - parseInt(a.timeStamp))
      .slice(0, 10)

    largeTxs.forEach((t) => {
      if (t.from !== ZERO_ADDRESS) allAddressesForNames.add(t.from.toLowerCase())
      if (t.to !== ZERO_ADDRESS) allAddressesForNames.add(t.to.toLowerCase())
    })

    const txNameTags = await fetchNameTags([...allAddressesForNames])

    const recentLargeTransfers: LargeTransfer[] = largeTxs.map(
      (t: ERC20Transfer) => ({
        hash: t.hash,
        from: t.from,
        fromName: txNameTags[t.from.toLowerCase()]?.nameTag ?? null,
        to: t.to,
        toName: txNameTags[t.to.toLowerCase()]?.nameTag ?? null,
        valueUsd: (parseFloat(t.value) / 10 ** product.decimals) * navUsd,
        timestamp: parseInt(t.timeStamp),
        isMint: t.from === ZERO_ADDRESS,
        isBurn: t.to === ZERO_ADDRESS,
      })
    )

    const aumHistory = aumResult?.products[slug] ?? null

    return {
      productSlug: slug,
      productName: product.name,
      productSymbol: product.symbol,
      issuer: product.issuer,
      navUsd,
      navAsOf: product.navAsOf ?? null,
      holderCount,
      top5Share,
      dormancySharePct: agg.dormancySharePct,
      mix: agg.mix,
      netNewWallets90d: agg.netNewWallets90d,
      exitedWallets90d: agg.exitedWallets90d,
      netAccumulationRatio: agg.netAccumulationRatio,
      topHolders,
      recentLargeTransfers,
      aumHistory,
      isAggregateOnly: product.aggregateFlowsOnly ?? false,
      fetchedAt: transferData.fetchedAt,
    }
  } catch {
    return null
  }
}
