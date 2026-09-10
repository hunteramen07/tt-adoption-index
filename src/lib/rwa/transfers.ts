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
import type { EscalationFetch, ResolveOptions } from '@/src/lib/rwa/solana-resolve'
import { makeSupabaseAtaOwnerStore } from '@/src/lib/rwa/ata-owner-store'

const TRANSACTIONS_URL = 'https://api.rwa.xyz/v4/transactions'
const PER_PAGE = 1000
const THROTTLE_MS = 600

// ── Cross-window escalation bounds ──────────────────────────────────────────
// A closed ATA with no twin inside the fetched window is rare (~1 per dash-era day
// window, probe 2026-09-10) but must not stall the backfill, so we widen the pairing
// corpus with a couple of extra requests. Every bound below is a hard cap: escalation
// exists to unstick a boundary artifact, never to become a second crawler.
/** Addresses escalated per call. Beyond this, something systemic is wrong — the rest
 *  fail loud rather than being papered over by an unbounded fan-out. */
const ESCALATION_MAX_ADDRESSES = 100
/** Transaction hashes probed for twins (a handful of records per address suffices). */
const ESCALATION_MAX_HASHES = 100
/** Total pages one escalation may spend, across BOTH of its queries. */
const ESCALATION_MAX_PAGES = 4

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
 * Post-filter one page to the allowed token address(es), assert the configured
 * decimals, and normalize into RwaTransfer. Shared by every puller so the token
 * filter (Finding #2, excludes BUIDL-I) and the decimals guard cannot drift apart.
 */
function collectResults(
  results: readonly RwaTransaction[],
  allowed: Set<string>,
  decimals: number,
  networkId: number,
  out: RwaTransfer[]
): void {
  for (const tx of results) {
    // Post-filter to the allowed token address(es) — excludes BUIDL-I etc.
    if (!allowed.has(tx.token.address.toLowerCase())) continue
    // Guard: the configured decimals MUST match what rwa.xyz reports for this token,
    // or toRawUnits would silently mis-scale raw balances by a power of ten.
    if (tx.token.decimals !== decimals) {
      throw new Error(
        `rwa.xyz decimals mismatch (network ${networkId}, token ${tx.token.address}): ` +
        `config ${decimals} vs rwa.xyz ${tx.token.decimals}`
      )
    }
    out.push(normalizeTransaction(tx, decimals))
  }
}

/** Build the `query` URL for one /v4/transactions page. */
function transactionsUrl(
  filters: ReadonlyArray<Record<string, unknown>>,
  page: number,
  perPage: number
): string {
  const query = {
    filter: { operator: 'and', filters },
    // id-sort: deterministic, non-overlapping pagination (date-sort caused
    // progressive page timeouts). The engine is order-invariant.
    sort: { field: 'id', direction: 'asc' },
    pagination: { page, perPage },
  }
  return `${TRANSACTIONS_URL}?query=${encodeURIComponent(JSON.stringify(query))}`
}

/**
 * Cross-window escalation for the Solana resolver (ladder rung 5).
 *
 * Given closed ATAs that no twin in the fetched window could resolve, pull enough
 * extra records to pair them from elsewhere in history — in TWO queries for the whole
 * set, not per address:
 *
 *   1. every record naming any unresolved address (`in` on to_address / from_address),
 *      which yields that address's dash records and their transaction hashes;
 *   2. every record of those hashes, which brings in the underscore twins — they carry
 *      DIFFERENT addresses by construction, so query 1 cannot return them.
 *
 * The caller's `pageCounter` accumulates pages spent so the backfill's per-run request
 * budget still sees them; escalation is never free of the 120/hr ceiling.
 *
 * Returns [] (rather than throwing) when nothing useful comes back — the resolver then
 * fails loud with its own, far more diagnosable message.
 */
export function makeEscalationFetch(
  assetId: number,
  networkId: number,
  decimals: number,
  tokenAddresses: string[],
  apiKey: string,
  pageCounter?: { pages: number }
): EscalationFetch {
  const allowed = new Set(tokenAddresses.map((a) => a.toLowerCase()))
  const base = [
    { operator: 'equals', field: 'asset_id', value: assetId },
    { operator: 'equals', field: 'network_id', value: networkId },
  ]

  return async (addresses: string[]): Promise<RwaTransfer[]> => {
    const targets = addresses.slice(0, ESCALATION_MAX_ADDRESSES)
    if (targets.length === 0) return []
    let pagesLeft = ESCALATION_MAX_PAGES
    const out: RwaTransfer[] = []

    const spend = async (filters: ReadonlyArray<Record<string, unknown>>, label: string) => {
      let page = 1
      let pageCount = 1
      while (page <= pageCount && pagesLeft > 0) {
        const data = await fetchRwaJson<RwaTransactionsResponse>(
          transactionsUrl(filters, page, PER_PAGE), '/v4/transactions', page, apiKey
        )
        pageCount = data.pagination.pageCount
        pagesLeft--
        if (pageCounter) pageCounter.pages++
        collectResults(data.results, allowed, decimals, networkId, out)
        console.log(`[solana-resolve] escalation ${label} page ${page}/${pageCount} (${out.length} records)`)
        page++
        if (page <= pageCount && pagesLeft > 0) await sleep(THROTTLE_MS)
      }
    }

    console.log(`[solana-resolve] escalating ${targets.length} unresolved closed ATA(s) — up to ${ESCALATION_MAX_PAGES} extra page(s)`)
    await spend(
      [...base, { operator: 'or', filters: [
        { operator: 'in', field: 'to_address', value: targets },
        { operator: 'in', field: 'from_address', value: targets },
      ] }],
      'by-address'
    )

    // Only the dash records need twins; take their hashes (bounded), then pull every
    // record of those transactions so the underscore side comes with them.
    const hashes = [...new Set(out.filter((t) => !t.id.includes('_')).map((t) => t.hash))]
      .slice(0, ESCALATION_MAX_HASHES)
    if (hashes.length > 0 && pagesLeft > 0) {
      await sleep(THROTTLE_MS)
      await spend([...base, { operator: 'in', field: 'transaction_hash', value: hashes }], 'by-hash')
    }
    return out
  }
}

/**
 * Default Solana resolve options: the on-chain lookup (built in), the persisted
 * ATA→owner map, and cross-window escalation. Callers that pass their own
 * `options.resolve` get it verbatim — that is the offline/test override path, and it
 * deliberately does NOT merge, so a test can prove behaviour with escalation absent.
 */
function defaultResolveOptions(
  assetId: number,
  networkId: number,
  decimals: number,
  tokenAddresses: string[],
  apiKey: string,
  pageCounter?: { pages: number }
): ResolveOptions {
  return {
    store: makeSupabaseAtaOwnerStore(),
    escalate: makeEscalationFetch(assetId, networkId, decimals, tokenAddresses, apiKey, pageCounter),
  }
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
  options: { maxPages?: number; sinceDate?: string; resolve?: ResolveOptions } = {}
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
    // Per-request timeout + transient-failure retry (shared helper).
    const data = await fetchRwaJson<RwaTransactionsResponse>(
      transactionsUrl(filters, page, PER_PAGE), '/v4/transactions', page, apiKey
    )
    pageCount = data.pagination.pageCount

    collectResults(data.results, allowed, decimals, networkId, out)

    console.log(`[rwa] fetched page ${page}/${pageCount} (${out.length} transfers so far)`)

    page++
    if (page <= pageCount && page <= maxPages) await sleep(THROTTLE_MS)
  }

  // Solana-only: resolve ATA→owner and dedup the dual-feed twins so everything
  // downstream keys on owner wallets. No-op (byte-identical) for every other chain.
  if (networkId === SOLANA_NETWORK_ID) {
    return resolveAndDedupSolana(
      out,
      options.resolve ?? defaultResolveOptions(assetId, networkId, decimals, tokenAddresses, apiKey)
    )
  }
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
  ltDate: string,
  options: { resolve?: ResolveOptions } = {}
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
    // id-sort, same as the unbounded pull: deterministic, non-overlapping
    // pagination. The date bounds narrow the set; order within is irrelevant
    // (the merge is order-invariant and the caller dedups the boundary day).
    const data = await fetchRwaJson<RwaTransactionsResponse>(
      transactionsUrl(filters, page, PER_PAGE), '/v4/transactions', page, apiKey
    )
    pageCount = data.pagination.pageCount
    pagesFetched++

    collectResults(data.results, allowed, decimals, networkId, out)

    console.log(`[rwa] window [${gteDate},${ltDate}) page ${page}/${pageCount} (${out.length} transfers)`)
    page++
    if (page <= pageCount) await sleep(THROTTLE_MS)
  }

  // Solana-only: resolve ATA→owner + dedup twins (see fetchTransfersRWA). Pages spent
  // on a cross-window escalation are counted into the returned total so the backfill's
  // per-run pool sees every request this window cost. Post-fetch dedup does not affect
  // the count — it is a request count, not a record count. (If resolution THROWS, the
  // ≤4 escalation pages go unbilled: the caller discards the window and this network's
  // run ends, so the pool only under-counts by that bounded amount for the run's other
  // networks. Accepted rather than restructured — see design doc §A4.)
  if (networkId !== SOLANA_NETWORK_ID) return { transfers: out, pages: pagesFetched }

  const escalationPages = { pages: 0 }
  const transfers = await resolveAndDedupSolana(
    out,
    options.resolve ??
      defaultResolveOptions(assetId, networkId, decimals, tokenAddresses, apiKey, escalationPages)
  )
  return { transfers, pages: pagesFetched + escalationPages.pages }
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
