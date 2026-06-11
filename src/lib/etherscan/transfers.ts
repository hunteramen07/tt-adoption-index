import type { Product } from '@/src/config/products'
import { etherscanGet } from './client'
import { diskCacheRead, diskCacheReadStale, diskCacheWrite } from '@/src/lib/cache/disk'
import type { ERC20Transfer, TransferHistoryData } from './types'

// Fetch new blocks after this many ms since the last full fetch.
// Historical transfers are immutable so a 6-hour window is conservative.
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000

const PAGE_SIZE = 100 // Etherscan max per page

/**
 * Full ERC-20 transfer history for a token, with disk-backed incremental caching.
 *
 * On the first call: pages through all transfers from block 0.
 * On subsequent calls within 6 hours: returns the disk cache immediately.
 * After 6 hours: fetches only blocks newer than the last cached block and
 *   appends them to the existing dataset.
 *
 * The underlying etherscanGet respects the 5 calls/sec free-tier rate limit.
 *
 * @param options.maxPages  Cap the number of API pages per run (100 tx/page).
 *   Defaults to Infinity for a complete fetch. Set to a small number (e.g. 2)
 *   on the debug endpoint to avoid long first-run latency.
 */
export async function fetchTransferHistory(
  product: Product,
  options: { maxPages?: number } = {}
): Promise<TransferHistoryData> {
  const { maxPages = Infinity } = options
  const cacheKey = `transfers-${product.contractAddress.toLowerCase()}`

  const fresh = diskCacheRead<ERC20Transfer[]>(cacheKey, CACHE_MAX_AGE_MS)
  if (fresh) {
    return toResult(product.slug, fresh.data, fresh.lastBlock, fresh.fetchedAt, true)
  }

  const stale = diskCacheReadStale<ERC20Transfer[]>(cacheKey)
  const startBlock = stale ? stale.lastBlock + 1 : 0
  const existing: ERC20Transfer[] = stale?.data ?? []

  const newTransfers: ERC20Transfer[] = []
  let lastBlock = stale?.lastBlock ?? 0
  let page = 1
  // Distinguish null (API/network error) from [] (legitimate end of data).
  // Only write to disk when the API actually responded successfully.
  let apiSucceeded = false

  while (page <= maxPages) {
    const batch = await etherscanGet<ERC20Transfer[]>({
      module: 'account',
      action: 'tokentx',
      contractaddress: product.contractAddress,
      startblock: startBlock.toString(),
      endblock: '99999999',
      page: page.toString(),
      offset: PAGE_SIZE.toString(),
      sort: 'asc',
    })

    if (batch === null) break  // API/network error — don't mark success
    apiSucceeded = true
    if (batch.length === 0) break  // legitimate end of data

    newTransfers.push(...batch)

    const maxBatchBlock = batch.reduce(
      (max, t) => Math.max(max, parseInt(t.blockNumber, 10)),
      0
    )
    if (maxBatchBlock > lastBlock) lastBlock = maxBatchBlock

    if (batch.length < PAGE_SIZE) break // reached the last page
    page++
  }

  const allTransfers = [...existing, ...newTransfers]
  const now = Date.now()

  // Write rules (never cache an empty result from a failed first fetch):
  //   • Got data → cache it.
  //   • Incremental update, API succeeded, 0 new tx → refresh timestamp only.
  //   • API failed on a cold cache → write nothing.
  if (allTransfers.length > 0) {
    diskCacheWrite(cacheKey, { fetchedAt: now, lastBlock, data: allTransfers })
  } else if (stale !== null && apiSucceeded) {
    diskCacheWrite(cacheKey, { ...stale, fetchedAt: now })
  }

  return toResult(product.slug, allTransfers, lastBlock, now, false)
}

function toResult(
  productSlug: string,
  transfers: ERC20Transfer[],
  lastBlock: number,
  fetchedAt: number,
  fromCache: boolean
): TransferHistoryData {
  return {
    productSlug,
    transfers,
    totalCount: transfers.length,
    lastBlock,
    fetchedAt: new Date(fetchedAt).toISOString(),
    fromCache,
  }
}
