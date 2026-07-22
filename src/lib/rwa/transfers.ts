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
import { fetchRwaJson } from '@/src/lib/rwa/http'
import { resolveAndDedupSolana, SOLANA_NETWORK_ID } from '@/src/lib/rwa/solana-resolve'

const TRANSACTIONS_URL = 'https://api.rwa.xyz/v4/transactions'
const PER_PAGE = 1000
const THROTTLE_MS = 600
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

    // Fetch with per-request timeout + transient-failure retry (shared helper).
    const data = await fetchRwaJson<RwaTransactionsResponse>(url, '/v4/transactions', page, apiKey)
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

  // Solana-only: resolve ATA→owner and dedup the dual-feed twins so everything
  // downstream keys on owner wallets. No-op (byte-identical) for every other chain.
  if (networkId === SOLANA_NETWORK_ID) return resolveAndDedupSolana(out)
  return out
}

/**
 * Date-BOUNDED window pull for the chunked backfill — the same paginated fetch as
 * fetchTransfersRWA, but with BOTH a `gte(date)` lower bound and an `lt(date)`
 * upper bound (probe-confirmed 2026-07-20: `lt` is accepted, respects both bounds,
 * and composes with the id-sort). Returns the transfers AND the page count so the
 * backfill can enforce a per-run request budget and size windows adaptively.
 *
 * Windows are day-granular `[gteDate, ltDate)` (both YYYY-MM-DD). Kept SEPARATE
 * from fetchTransfersRWA so that function — and its parity gate — stay untouched.
 *
 * @param gteDate inclusive window start, YYYY-MM-DD (UTC day)
 * @param ltDate  exclusive window end, YYYY-MM-DD (UTC day)
 */
export async function fetchTransfersWindowRWA(
  assetId: number,
  networkId: number,
  decimals: number,
  tokenAddresses: string[],
  gteDate: string,
  ltDate: string
): Promise<{ transfers: RwaTransfer[]; pages: number }> {
  const apiKey = process.env.RWA_API_KEY
  if (!apiKey) throw new Error('RWA_API_KEY environment variable is not set')

  const allowed = new Set(tokenAddresses.map((a) => a.toLowerCase()))
  const out: RwaTransfer[] = []

  const filters: Array<{ operator: string; field: string; value: string | number }> = [
    { operator: 'equals', field: 'asset_id', value: assetId },
    { operator: 'equals', field: 'network_id', value: networkId },
    { operator: 'gte', field: 'date', value: gteDate },
    { operator: 'lt', field: 'date', value: ltDate },
  ]

  let page = 1
  let pageCount = 1
  let pagesFetched = 0

  while (page <= pageCount) {
    const query = {
      filter: { operator: 'and', filters },
      // id-sort, same as the unbounded pull: deterministic, non-overlapping
      // pagination. The date bounds narrow the set; order within is irrelevant
      // (the merge is order-invariant and the caller dedups the boundary day).
      sort: { field: 'id', direction: 'asc' },
      pagination: { page, perPage: PER_PAGE },
    }
    const url = `${TRANSACTIONS_URL}?query=${encodeURIComponent(JSON.stringify(query))}`

    const data = await fetchRwaJson<RwaTransactionsResponse>(url, '/v4/transactions', page, apiKey)
    pageCount = data.pagination.pageCount
    pagesFetched++

    for (const tx of data.results) {
      if (!allowed.has(tx.token.address.toLowerCase())) continue
      if (tx.token.decimals !== decimals) {
        throw new Error(
          `rwa.xyz decimals mismatch (network ${networkId}, token ${tx.token.address}): ` +
          `config ${decimals} vs rwa.xyz ${tx.token.decimals}`
        )
      }
      out.push(normalizeTransaction(tx, decimals))
    }

    console.log(`[rwa] window [${gteDate},${ltDate}) page ${page}/${pageCount} (${out.length} transfers)`)
    page++
    if (page <= pageCount) await sleep(THROTTLE_MS)
  }

  // Solana-only: resolve ATA→owner + dedup twins (see fetchTransfersRWA). The page
  // count is the request count and is unaffected by post-fetch dedup.
  const transfers = networkId === SOLANA_NETWORK_ID ? await resolveAndDedupSolana(out) : out
  return { transfers, pages: pagesFetched }
}

/**
 * Earliest transaction DATE (YYYY-MM-DD, UTC) for an (asset, network), or null if
 * the network has no transactions. Used to seed a fresh chunked backfill's first
 * window instead of scanning from a hardcoded epoch.
 *
 * This is the one place we sort by `date` rather than `id`. The date-sort timeout
 * that pushed the main pull to id-sort was a DEEP-pagination problem (page 500+);
 * this is a single page-1, perPage-1 query — the cheapest possible — so it does not
 * hit that. No token post-filter: the earliest tx of ANY token on the network is a
 * safe lower bound (we never miss tracked data by starting a shade early).
 */
export async function fetchEarliestTxDate(
  assetId: number,
  networkId: number
): Promise<string | null> {
  const apiKey = process.env.RWA_API_KEY
  if (!apiKey) throw new Error('RWA_API_KEY environment variable is not set')

  const query = {
    filter: {
      operator: 'and',
      filters: [
        { operator: 'equals', field: 'asset_id', value: assetId },
        { operator: 'equals', field: 'network_id', value: networkId },
      ],
    },
    sort: { field: 'date', direction: 'asc' },
    pagination: { page: 1, perPage: 1 },
  }
  const url = `${TRANSACTIONS_URL}?query=${encodeURIComponent(JSON.stringify(query))}`
  const data = await fetchRwaJson<RwaTransactionsResponse>(url, '/v4/transactions', 1, apiKey)

  const first = data.results[0]
  if (!first) return null
  return first.timestamp.slice(0, 10) // ISO → YYYY-MM-DD (UTC)
}
