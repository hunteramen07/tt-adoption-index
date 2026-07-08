/**
 * rwa.xyz transfer fetch + normalizer — the PARALLEL multi-chain fetch path.
 *
 * This is a standalone module for the multi-chain pipeline rewrite (roadmap
 * item 2, Stage 1). It is NOT wired into the classify pipeline yet — the live
 * pipeline still fetches from Etherscan (src/lib/etherscan/transfers.ts).
 *
 * It fetches transactions from rwa.xyz /v4/transactions and normalizes each one
 * into the EXISTING `ERC20Transfer` shape so the classify engine can consume
 * them with zero changes. The engine only reads four fields per transfer —
 * `from`, `to`, `value` (raw integer string → BigInt), and `timeStamp` (Unix
 * seconds string → parseInt); every other field is a placeholder.
 *
 * See _local/stage1-rwa-fetch-normalizer-spec.md for the field mapping and the
 * two critical findings: (1) rwa.xyz `amount` is decimal-adjusted, not raw, so
 * it needs string-based conversion to raw units; (2) asset_id + network_id
 * catches BOTH Ethereum BUIDL contracts, so results are post-filtered to the
 * allowed token address(es) to exclude the restricted BUIDL-I class.
 */

import type { ERC20Transfer } from '@/src/lib/etherscan/types'

const TRANSACTIONS_URL = 'https://api.rwa.xyz/v4/transactions'
const PER_PAGE = 1000
const THROTTLE_MS = 600
const REQUEST_TIMEOUT_MS = 90_000
// Per-page transient-failure retry. rwa.xyz occasionally returns a transport
// error (e.g. an upstream Databricks `connect ETIMEDOUT`, sometimes wrapped in a
// 400) or a 5xx mid-pagination; without retry a single bad page aborts the whole
// multi-chain run. Bounded exponential backoff, then fail loudly.
const MAX_PAGE_RETRIES = 3
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000]
// Mint/burn counterparty marker — matches the zero-address string EVM uses, so
// the classify engine treats coerced Solana mints/burns identically to EVM ones.
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Convert rwa.xyz's decimal-adjusted `amount` (e.g. 330.15 for 330.15 tokens)
 * into a raw integer string in smallest units (e.g. "330150000" at 6 decimals).
 *
 * Uses STRING manipulation — never `amount * 10 ** decimals`, which loses
 * precision on large magnitudes (e.g. 399584954.82). `toFixed` can still carry
 * float noise at very large magnitudes; if a Stage 2 parity check diverges at
 * huge values, switch to a decimal library (flagged in the spec).
 */
export function toRawUnits(amount: number, decimals: number): string {
  const s = amount.toFixed(decimals) // pins to `decimals` places
  const [whole, frac = ''] = s.split('.')
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals)
  const raw = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '') // strip leading zeros
  return raw === '' ? '0' : raw
}

/**
 * A normalized transfer that additionally carries the rwa.xyz transaction `id`.
 * The classify engine never reads `id` (it only reads from/to/value/timeStamp),
 * so this is assignable to ERC20Transfer[] and existing callers are unaffected.
 * The incremental fetch-merge layer uses `id` for boundary dedup and cursoring.
 */
export type RwaTransfer = ERC20Transfer & { id: string }

/** Subset of a rwa.xyz /v4/transactions result that we actually read. */
export interface RwaTransaction {
  /**
   * Stable, monotonically-increasing transaction key. This is the field the
   * fetch sorts on (sort.field = 'id', asc) for deterministic pagination, and
   * the key the incremental layer dedups/cursors on. Captured as a string so
   * it round-trips losslessly through the `text` cursor column regardless of
   * whether rwa.xyz serializes it as a JSON number or string.
   */
  id: number | string
  /**
   * Counterparties. On Ethereum, mints/burns use the zero-address STRING, so
   * these are always present. On some non-EVM networks (observed on Solana)
   * rwa.xyz returns null here instead — a null from_address on a mint, or a
   * null to_address on a burn. normalizeTransaction coerces those to the
   * zero-address string (matching EVM) and throws on any other null.
   */
  from_address: string | null
  to_address: string | null
  /** Decimal-adjusted token count, NOT raw units. */
  amount: number
  /** Precise ISO timestamp, e.g. "2026-06-16T14:37:59.000Z". */
  timestamp: string
  transaction_hash: string
  /**
   * rwa.xyz transaction classification object. Its `slug` distinguishes the
   * transaction kind; slugs containing "mint"/"burn" identify mints/burns,
   * which on non-EVM chains arrive with a null counterparty.
   */
  transaction_type: { slug: string } | null
  /**
   * Carries the on-chain token contract (used to post-filter, Finding #2) and the
   * token's decimals (`amount` is decimal-adjusted to this — the figure the config
   * value is asserted against at fetch time).
   */
  token: { address: string; decimals: number }
}

interface RwaTransactionsResponse {
  results: RwaTransaction[]
  pagination: { page: number; perPage: number; pageCount: number; resultCount?: number }
}

/**
 * Map a rwa.xyz transaction into the existing `ERC20Transfer` shape. Only the
 * four engine-read fields carry real data; everything else is an empty-string
 * placeholder (and blockNumber "0" — rwa.xyz transactions have no block number,
 * and the engine never reads it).
 *
 * Non-EVM (e.g. Solana) mints/burns arrive with a null counterparty instead of
 * EVM's zero-address string. We coerce those to the zero-address — but ONLY when
 * the transaction_type slug confirms a mint (null from) or burn (null to). Any
 * other null is unexpected and throws, so we never silently corrupt balances.
 */
export function normalizeTransaction(tx: RwaTransaction, decimals: number): RwaTransfer {
  const slug = tx.transaction_type?.slug

  let from = tx.from_address
  if (from == null) {
    if (slug?.includes('mint')) {
      from = ZERO_ADDRESS
    } else {
      throw new Error(`null from_address on non-mint tx: slug=${slug} hash=${tx.transaction_hash}`)
    }
  }

  let to = tx.to_address
  if (to == null) {
    if (slug?.includes('burn')) {
      to = ZERO_ADDRESS
    } else {
      throw new Error(`null to_address on non-burn tx: slug=${slug} hash=${tx.transaction_hash}`)
    }
  }

  return {
    id: String(tx.id),
    from,
    to,
    value: toRawUnits(tx.amount, decimals),
    timeStamp: String(Math.floor(new Date(tx.timestamp).getTime() / 1000)),
    blockNumber: '0',
    hash: tx.transaction_hash,
    nonce: '',
    blockHash: '',
    contractAddress: '',
    tokenName: '',
    tokenSymbol: '',
    tokenDecimal: '',
    transactionIndex: '',
    gas: '',
    gasPrice: '',
    gasUsed: '',
    cumulativeGasUsed: '',
    input: '',
    confirmations: '',
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Transient (retryable) failures: any 5xx, plus the rwa.xyz case where an upstream
 * connect error (ETIMEDOUT/ECONNRESET/…) is surfaced as a 400 whose body carries
 * the transport error string. A "clean" 400/401/403/422 is a real client error and
 * is NOT retried — it would fail every attempt and should surface immediately.
 */
function isRetryableHttp(status: number, body: string): boolean {
  if (status >= 500) return true
  if (status === 400 && /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|reason: connect/i.test(body)) {
    return true
  }
  return false
}

/**
 * Fetch one page of /v4/transactions with the per-request timeout AND a bounded
 * exponential-backoff retry over transient transport failures (timeout/abort,
 * 5xx, or a 400 wrapping an upstream connect error). A non-retryable HTTP error
 * throws immediately; exhausting the retries rethrows the last error, preserving
 * the original timeout / `HTTP <status> — <body>` message shape callers expect.
 */
async function fetchTransactionsPage(
  url: string,
  page: number,
  apiKey: string
): Promise<RwaTransactionsResponse> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]
      console.log(
        `[rwa] retrying page ${page} (attempt ${attempt + 1}/${MAX_PAGE_RETRIES + 1}) after ${backoff}ms — ${lastErr?.message ?? ''}`
      )
      await sleep(backoff)
    }

    // Per-request timeout so a stalled page fails (and retries) instead of hanging.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch (err) {
      // Network error or timeout abort — transient; record and retry.
      lastErr = controller.signal.aborted
        ? new Error(`rwa.xyz /v4/transactions timed out (page ${page}) after ${REQUEST_TIMEOUT_MS}ms`)
        : (err as Error)
      continue
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      const body = await res.text()
      const err = new Error(`rwa.xyz /v4/transactions failed (page ${page}): HTTP ${res.status} — ${body}`)
      if (isRetryableHttp(res.status, body)) {
        lastErr = err
        continue
      }
      throw err // non-retryable client error — surface immediately
    }

    return (await res.json()) as RwaTransactionsResponse
  }
  throw lastErr ?? new Error(`rwa.xyz /v4/transactions failed (page ${page}) after ${MAX_PAGE_RETRIES + 1} attempts`)
}

/**
 * Fetch + normalize all transactions for one (asset, network), paginating
 * rwa.xyz /v4/transactions and post-filtering to the allowed token addresses.
 *
 * @param assetId        rwa.xyz asset_id (Product.rwaAssetId)
 * @param networkId      rwa.xyz network_id (ProductToken.networkId)
 * @param decimals       token decimals, for raw-unit conversion
 * @param tokenAddresses allowed contract addresses; results whose token.address
 *                       is not in this set are dropped (case-insensitive). This
 *                       is how BUIDL-I is excluded — pass only the tracked class.
 * @param options.maxPages  cap on pages fetched (for testing; omit for all pages)
 * @param options.sinceDate optional ISO timestamp; when set, injects an
 *                          inclusive `{operator:'gte', field:'date'}` filter so
 *                          only transactions at or after it are pulled. This is
 *                          how the incremental layer resumes from a cursor (and
 *                          how the bounded trailing-90d window query is built).
 *                          Omit for a full pull. NOTE: gte is INCLUSIVE, so the
 *                          boundary second is re-fetched — the incremental
 *                          caller must dedup by id (see incremental.ts).
 *
 * Throttled to ~600ms between requests. Throws on any non-200 response.
 */
export async function fetchTransfersRWA(
  assetId: number,
  networkId: number,
  decimals: number,
  tokenAddresses: string[],
  options: { maxPages?: number; sinceDate?: string } = {}
): Promise<RwaTransfer[]> {
  const apiKey = process.env.RWA_API_KEY
  if (!apiKey) throw new Error('RWA_API_KEY environment variable is not set')

  const maxPages = options.maxPages ?? Infinity
  const allowed = new Set(tokenAddresses.map((a) => a.toLowerCase()))
  const out: RwaTransfer[] = []

  // Built once; the gte(date) filter is appended only when resuming/bounding.
  const filters: Array<{ operator: string; field: string; value: string | number }> = [
    { operator: 'equals', field: 'asset_id', value: assetId },
    { operator: 'equals', field: 'network_id', value: networkId },
  ]
  if (options.sinceDate) {
    filters.push({ operator: 'gte', field: 'date', value: options.sinceDate })
  }

  let page = 1
  let pageCount = 1 // updated from the first response

  while (page <= pageCount && page <= maxPages) {
    const query = {
      filter: {
        operator: 'and',
        filters,
      },
      // Sort on the stable `id` key, not `date`: gives deterministic,
      // non-overlapping pagination cheaply (date-sort caused progressive page
      // timeouts). The classify engine is order-invariant, so id-order is fine.
      sort: { field: 'id', direction: 'asc' },
      pagination: { page, perPage: PER_PAGE },
    }

    // rwa.xyz /v4 takes the query object as a single URL-encoded `query` param.
    const url = `${TRANSACTIONS_URL}?query=${encodeURIComponent(JSON.stringify(query))}`

    // Fetch with per-request timeout + transient-failure retry (see helper).
    const data = await fetchTransactionsPage(url, page, apiKey)
    pageCount = data.pagination.pageCount

    for (const tx of data.results) {
      // Post-filter to the allowed token address(es) — excludes BUIDL-I etc.
      if (!allowed.has(tx.token.address.toLowerCase())) continue
      // Guard: the configured decimals MUST match what rwa.xyz reports for this
      // token, or toRawUnits would silently mis-scale raw balances by a power of
      // ten. Fires for every rwa-path network (confirms fund-level fallbacks too).
      if (tx.token.decimals !== decimals) {
        throw new Error(
          `rwa.xyz decimals mismatch (network ${networkId}, token ${tx.token.address}): ` +
          `config ${decimals} vs rwa.xyz ${tx.token.decimals}`
        )
      }
      out.push(normalizeTransaction(tx, decimals))
    }

    console.log(`[rwa] fetched page ${page}/${pageCount} (${out.length} transfers so far)`)

    page++
    if (page <= pageCount && page <= maxPages) await sleep(THROTTLE_MS)
  }

  return out
}
