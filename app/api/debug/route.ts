import { connection } from 'next/server'
import { revalidateTag } from 'next/cache'
import { ACTIVE_PRODUCTS } from '@/src/config/products'
import { etherscanGetRaw } from '@/src/lib/etherscan/client'
import { fetchHolderStats } from '@/src/lib/etherscan/holders'
import { fetchTransferHistory } from '@/src/lib/etherscan/transfers'
import { fetchNameTags } from '@/src/lib/etherscan/nameTags'
import { diskCacheClearAll } from '@/src/lib/cache/disk'
import { fetchAumHistory } from '@/src/lib/dune/supplyHistory'

/**
 * GET /api/debug
 * GET /api/debug?clear=1   — clears disk cache + invalidates use-cache entries,
 *                            then immediately re-fetches fresh data
 *
 * Sections returned:
 *   diagnostics    env var check + one raw Etherscan call with full response
 *   holderStats    holder count + top-10 holders derived from transfer history (USTB)
 *   transferSample last 5 transfers from the disk-cached history (USTB)
 *   nameTags       name-tag lookup for the top 3 holder addresses
 *
 * holderCount and topHolders are derived by replaying the full on-chain transfer
 * history — tokenholdercount and tokenholderlist are Etherscan Pro-only endpoints.
 *
 * First cold run: expect ~15–30 s while transfers are fetched (capped at 5 pages).
 * Subsequent calls within cache TTLs return in < 1 s.
 */
export async function GET(request: Request) {
  await connection()

  const { searchParams } = new URL(request.url)

  // ── Cache clear ──────────────────────────────────────────────────────────
  if (searchParams.get('clear') === '1') {
    diskCacheClearAll()
    revalidateTag('etherscan-data', 'seconds')
    revalidateTag('dune-data', 'seconds')
    return Response.json({
      cleared: true,
      message: 'Disk cache deleted and use-cache entries invalidated. Hit /api/debug to re-fetch.',
    })
  }

  const apiKey = process.env.ETHERSCAN_API_KEY
  const duneApiKey = process.env.DUNE_API_KEY

  // ── Diagnostics ──────────────────────────────────────────────────────────
  const diagnostics: Record<string, unknown> = {
    apiKeyPresent: !!apiKey,
    apiKeyLength: apiKey?.length ?? 0,
    duneApiKeyPresent: !!duneApiKey,
  }

  if (!apiKey) {
    return Response.json(
      { diagnostics, error: 'ETHERSCAN_API_KEY is not configured' },
      { status: 500 }
    )
  }

  const sample = ACTIVE_PRODUCTS.find((p) => p.slug === 'ustb')!

  // Raw connectivity test — surfaces the full Etherscan response body
  const rawTest = await etherscanGetRaw({
    module: 'stats',
    action: 'tokensupply',
    contractaddress: sample.contractAddress,
  })
  diagnostics.rawApiTest = {
    action: 'tokensupply',
    contractaddress: sample.contractAddress,
    httpStatus: rawTest.httpStatus,
    status: rawTest.status,
    message: rawTest.message,
    result: rawTest.result,
    error: rawTest.error,
  }

  if (rawTest.status !== '1') {
    return Response.json(
      { diagnostics, error: 'Etherscan connectivity check failed — see diagnostics.rawApiTest' },
      { status: 502 }
    )
  }

  // ── Data fetches ──────────────────────────────────────────────────────────
  // holderCount and topHolders are DERIVED from on-chain transfer history:
  //   1. fetchTransferHistory pages through tokentx (free tier) and disk-caches the result.
  //   2. deriveHolderStats replays transfers to compute running balances per address.
  //   3. Results are sorted to find top-N holders and counted for holderCount.
  // This replaces the Pro-only tokenholdercount / tokenholderlist endpoints.

  const errors: Record<string, string> = {}

  // Cap at 5 pages (500 tx) on the debug route — full history for USTB is ~few hundred tx.
  let holderStats: Awaited<ReturnType<typeof fetchHolderStats>> | null = null
  try {
    holderStats = await fetchHolderStats(sample, { maxTransferPages: 5 })
  } catch (err) {
    errors.holderStats = String(err)
  }

  // Re-read the transfer data (hits the disk cache written by fetchHolderStats above)
  let transferData: Awaited<ReturnType<typeof fetchTransferHistory>> | null = null
  try {
    transferData = await fetchTransferHistory(sample, { maxPages: 5 })
  } catch (err) {
    errors.transferHistory = String(err)
  }

  // Name tags for top 3 addresses
  const topAddresses = holderStats?.topHolders.slice(0, 3).map((h) => h.address) ?? []
  let nameTags: Awaited<ReturnType<typeof fetchNameTags>> = {}
  try {
    nameTags = await fetchNameTags(topAddresses)
  } catch (err) {
    errors.nameTags = String(err)
  }

  // Dune AUM history
  let aumHistory: Awaited<ReturnType<typeof fetchAumHistory>> | null = null
  try {
    aumHistory = await fetchAumHistory()
  } catch (err) {
    errors.aumHistory = String(err)
  }

  const annotatedHolders = (holderStats?.topHolders ?? []).map((h) => ({
    ...h,
    nameTag: nameTags[h.address.toLowerCase()]?.nameTag ?? null,
  }))

  return Response.json({
    fetchedAt: new Date().toISOString(),
    sampleProduct: sample.slug,
    diagnostics,
    ...(Object.keys(errors).length > 0 && { errors }),
    holderStats: holderStats
      ? { ...holderStats, topHolders: annotatedHolders }
      : null,
    transferSample: transferData
      ? {
          productSlug: transferData.productSlug,
          totalCount: transferData.totalCount,
          lastBlock: transferData.lastBlock,
          fetchedAt: transferData.fetchedAt,
          fromCache: transferData.fromCache,
          recentTransfers: transferData.transfers.slice(-5),
        }
      : null,
    nameTags,
    // Per-product AUM history from Dune query 7696914
    // latest: most recent supply → AUM conversion
    // recentSeries: last 14 days (forward-filled, no gaps)
    aumHistory: aumHistory
      ? {
          fetchedAt: aumHistory.fetchedAt,
          executionId: aumHistory.executionId,
          queryState: aumHistory.queryState,
          products: Object.fromEntries(
            Object.entries(aumHistory.products).map(([slug, hist]) => [
              slug,
              hist
                ? {
                    latestDay: hist.latest?.day ?? null,
                    latestAumUsd: hist.latest?.aum ?? null,
                    latestSupplyRaw: hist.latest?.supplyRaw ?? null,
                    decimals: hist.decimals,
                    navUsd: hist.navUsd,
                    navAsOf: hist.navAsOf,
                    totalDays: hist.series.length,
                    recentSeries: hist.series.slice(-14),
                  }
                : null,
            ])
          ),
        }
      : null,
  })
}
