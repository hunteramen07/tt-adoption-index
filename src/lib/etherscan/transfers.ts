import type { Product } from '@/src/config/products'
import { etherscanGet } from './client'
import { diskCacheRead, diskCacheReadStale, diskCacheWrite } from '@/src/lib/cache/disk'
import type { ERC20Transfer, TransferHistoryData } from './types'

// Fetch new blocks after this many ms since the last full fetch.
// Historical transfers are immutable so a 6-hour window is conservative.
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000

// Etherscan v2 free-tier per-page result cap. This DROPPED from 10000 to 1000
// around 2026-07-16: the API silently returns only `min(offset, cap)` rows with
// status="1"/"OK" (no error), so requesting offset=10000 now yields 1000. A bare
// "short page ⇒ last page" break then absorbs that as end-of-history and truncates
// the fetch to a single oldest page (the USDY/OUSG 07-16 regression). Requesting
// exactly the cap keeps every non-final page full, so the short-page signal stays
// meaningful; the end-of-history probe below defends against the NEXT silent drop.
export const ETHERSCAN_MAX_PAGE_SIZE = 1000

// Debug endpoint default keeps small round-trips; batch callers pass
// ETHERSCAN_MAX_PAGE_SIZE. Both are ≤ the cap, so neither is silently truncated.
const DEFAULT_PAGE_SIZE = 100

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
 * @param options.maxPages  Cap the number of API pages per run. Defaults to
 *   Infinity for a complete fetch. Set to a small number (e.g. 2) on the
 *   debug endpoint to avoid long first-run latency.
 * @param options.pageSize  Results per API page (1–10000). Defaults to 100.
 *   Use 10000 in batch scripts to minimize round-trips.
 */
export async function fetchTransferHistory(
  product: Product,
  options: { maxPages?: number; pageSize?: number } = {}
): Promise<TransferHistoryData> {
  const { maxPages = Infinity, pageSize = DEFAULT_PAGE_SIZE } = options
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
  let iterations = 0
  // currentStartBlock advances with each full page so we never exceed the
  // Etherscan constraint: page × offset ≤ 10000. We always request page=1
  // and advance startblock to the block after the last result.
  let currentStartBlock = startBlock
  // Distinguish null (API/network error) from [] (legitimate end of data).
  // Only write to disk when the API actually responded successfully.
  let apiSucceeded = false

  while (iterations < maxPages) {
    const batch = await etherscanGet<ERC20Transfer[]>({
      module: 'account',
      action: 'tokentx',
      contractaddress: product.contractAddress,
      startblock: currentStartBlock.toString(),
      endblock: '99999999',
      page: '1',
      offset: pageSize.toString(),
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

    if (batch.length < pageSize) {
      // A short page usually means end-of-history — but it ALSO means "Etherscan
      // capped this page below pageSize", which is indistinguishable at this point
      // and, absorbed silently, is exactly the 07-16 truncation bug. VERIFY: probe
      // the next block range. Genuine end returns nothing; rows here mean the page
      // was capped and we would be truncating — fail loud so the cap change (e.g. a
      // future 1000→500 drop) is caught, not re-absorbed.
      //
      // Bounded retry on a transient probe error: an UNVERIFIED end is the exact
      // thing this guard must never trust, so a probe that keeps erroring throws
      // rather than proceeding — it does not get to silently decide the fetch ended.
      const PROBE_ATTEMPTS = 3
      let probe: ERC20Transfer[] | null = null
      for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
        probe = await etherscanGet<ERC20Transfer[]>({
          module: 'account',
          action: 'tokentx',
          contractaddress: product.contractAddress,
          startblock: (lastBlock + 1).toString(),
          endblock: '99999999',
          page: '1',
          offset: pageSize.toString(),
          sort: 'asc',
        })
        if (probe !== null) break
        if (attempt < PROBE_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      }
      if (probe === null) {
        throw new Error(
          `[etherscan] ${product.slug}: could not verify end-of-history — probe past block ${lastBlock} ` +
          `errored on all ${PROBE_ATTEMPTS} attempts. Refusing to trust an unverified end (risks silent truncation).`
        )
      }
      if (probe.length > 0) {
        throw new Error(
          `[etherscan] ${product.slug}: short page (${batch.length} < requested ${pageSize}) but ` +
          `${probe.length} more transfer(s) exist beyond block ${lastBlock} — suspected Etherscan per-page ` +
          `cap change (below ${pageSize}). Refusing to silently truncate; lower the batch pageSize to the new cap.`
        )
      }
      break // probe empty ⇒ genuinely the last page
    }
    // Full page — advance startblock to continue beyond the per-page cap.
    currentStartBlock = lastBlock + 1
    iterations++
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
