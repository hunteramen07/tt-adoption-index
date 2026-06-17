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
const REQUEST_TIMEOUT_MS = 30_000

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

/** Subset of a rwa.xyz /v4/transactions result that we actually read. */
export interface RwaTransaction {
  from_address: string
  to_address: string
  /** Decimal-adjusted token count, NOT raw units. */
  amount: number
  /** Precise ISO timestamp, e.g. "2026-06-16T14:37:59.000Z". */
  timestamp: string
  transaction_hash: string
  /** Carries the on-chain token contract; used to post-filter (Finding #2). */
  token: { address: string }
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
 */
export function normalizeTransaction(tx: RwaTransaction, decimals: number): ERC20Transfer {
  return {
    from: tx.from_address,
    to: tx.to_address,
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
 * @param options.maxPages cap on pages fetched (for testing; omit for all pages)
 *
 * Throttled to ~600ms between requests. Throws on any non-200 response.
 */
export async function fetchTransfersRWA(
  assetId: number,
  networkId: number,
  decimals: number,
  tokenAddresses: string[],
  options: { maxPages?: number } = {}
): Promise<ERC20Transfer[]> {
  const apiKey = process.env.RWA_API_KEY
  if (!apiKey) throw new Error('RWA_API_KEY environment variable is not set')

  const maxPages = options.maxPages ?? Infinity
  const allowed = new Set(tokenAddresses.map((a) => a.toLowerCase()))
  const out: ERC20Transfer[] = []

  let page = 1
  let pageCount = 1 // updated from the first response

  while (page <= pageCount && page <= maxPages) {
    const query = {
      filter: {
        operator: 'and',
        filters: [
          { operator: 'equals', field: 'asset_id', value: assetId },
          { operator: 'equals', field: 'network_id', value: networkId },
        ],
      },
      sort: { field: 'date', direction: 'asc' },
      pagination: { page, perPage: PER_PAGE },
    }

    // rwa.xyz /v4 takes the query object as a single URL-encoded `query` param.
    const url = `${TRANSACTIONS_URL}?query=${encodeURIComponent(JSON.stringify(query))}`

    // Per-request timeout so a stalled page fails loudly instead of hanging.
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
      if (controller.signal.aborted) {
        throw new Error(
          `rwa.xyz /v4/transactions timed out (page ${page}) after ${REQUEST_TIMEOUT_MS}ms`
        )
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`rwa.xyz /v4/transactions failed (page ${page}): HTTP ${res.status} — ${body}`)
    }

    const data = (await res.json()) as RwaTransactionsResponse
    pageCount = data.pagination.pageCount

    for (const tx of data.results) {
      // Post-filter to the allowed token address(es) — excludes BUIDL-I etc.
      if (!allowed.has(tx.token.address.toLowerCase())) continue
      out.push(normalizeTransaction(tx, decimals))
    }

    console.log(`[rwa] fetched page ${page}/${pageCount} (${out.length} transfers so far)`)

    page++
    if (page <= pageCount && page <= maxPages) await sleep(THROTTLE_MS)
  }

  return out
}
