/**
 * Incremental fetch-merge layer — the bridge between the rwa.xyz fetch path
 * (transfers.ts) and the proven engine cores (classify/engine.ts).
 *
 * NOT wired into the nightly classify.ts pipeline yet. It is built as its own
 * function with injectable IO (fetch + Supabase) so the merge/dedup/conversion
 * logic can be parity-gated in isolation (incremental ≡ full replay) before it
 * goes live. See scripts/incremental-merge-parity.ts.
 *
 * Per (product_slug, network) the orchestrator:
 *   1. reads the fetch_cursor row (null ⇒ full backfill)
 *   2. reads holder_balance_state into a BalanceStateMap
 *   3. pulls the all-time balance stream incrementally (gte cursor timestamp)
 *   4. dedups the inclusive-gte boundary by id  (the critical correctness step)
 *   5. merges new transactions into the balance map (exits retained as 0 rows)
 *   6. pulls the bounded trailing-90d window (independent of the cursor)
 *   7. classifies via the proven FromState cores (positive balances only)
 *   8. writes back balances + cursor ATOMICALLY (apply_incremental_merge RPC)
 *
 * (A) numeric↔bigint storage-boundary conversion is lossless — see
 *     parseNumericToBigInt / serializeBalance.
 * (B) balance + cursor writes are atomic via the apply_incremental_merge
 *     Postgres RPC (one transaction) — see WriteBackPayload.
 * (C) the former firstReceipt re-entrant divergence is RESOLVED: exited holders
 *     are retained as balance-0 rows with firstReceipt preserved, so netNew stays
 *     byte-identical to a full replay — see mergeTransfers.
 */

import type { RwaTransfer } from './transfers'
import { fetchTransfersRWA } from './transfers'
import {
  classifyHoldersFromState,
  computeAggregateStatsFromState,
  normalizeAddress,
  WINDOW_SECONDS,
} from '@/src/lib/classify/engine'
import type { HolderClassification } from '@/src/lib/classify/types'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Per-address persisted state. Mirrors a holder_balance_state row. */
export interface HolderState {
  balance: bigint
  /** Unix seconds of the address's first-ever receipt; null if unknown. */
  firstReceipt: number | null
}

export type BalanceStateMap = Map<string, HolderState>

/**
 * Mirrors a fetch_cursor row. The resume key is the TIMESTAMP, not the id:
 * rwa.xyz transaction ids are composite, non-numeric, and NOT time-ordered (see
 * the dedup note below), so they cannot order a cursor. `lastTxTimestamp` is the
 * ISO-8601 timestamp of the latest processed transaction; `boundaryIds` are the
 * composite ids of every transaction on that timestamp's UTC calendar DAY — the
 * rows the day-granular gte(date) re-fetch returns again next run and dedup drops.
 */
export interface FetchCursor {
  lastTxTimestamp: string
  boundaryIds: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) numeric ↔ bigint at the storage boundary — must be lossless.
//
// holder_balance_state.balance is Postgres `numeric` holding an INTEGER-valued
// raw token amount (e.g. 449946534147315186905 — far beyond 2^53). The danger is
// float coercion: PostgREST can serialize `numeric` as a JSON number, and parsing
// a 21-digit value through a JS `number` silently loses precision. We avoid that
// on BOTH sides:
//   • READ:  the loader must select `balance::text` (cast in the query) so the
//            value arrives as an exact decimal string, then parse it here.
//   • WRITE: serializeBalance emits the bigint as a string; supabase-js sends it
//            as a JSON string, which Postgres casts into `numeric` exactly. We
//            never hand the driver a JS number for a balance.
// parseNumericToBigInt rejects any non-integer fraction, so a float that sneaked
// into the column (".5") throws loudly instead of being truncated.
// ─────────────────────────────────────────────────────────────────────────────

/** Parse the string form of an integer-valued Postgres numeric into a bigint. */
export function parseNumericToBigInt(text: string): bigint {
  const s = text.trim()
  // Accept an optional all-zero fractional part (e.g. "100.000"); reject any
  // other fraction so silent float coercion in the path is caught, not hidden.
  const m = /^(-?\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) throw new Error(`balance is not a plain decimal string: "${text}"`)
  if (m[2] !== undefined && /[1-9]/.test(m[2])) {
    throw new Error(`balance has a non-integer fraction (float coercion?): "${text}"`)
  }
  return BigInt(m[1])
}

/** Serialize a bigint balance to the string form the numeric column accepts. */
export function serializeBalance(balance: bigint): string {
  return balance.toString()
}

export const isoToUnix = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000)
export const unixToIso = (unix: number): string => new Date(unix * 1000).toISOString()

/**
 * UTC calendar day (YYYY-MM-DD) of a unix-seconds timestamp.
 *
 * The rwa.xyz `date` filter is DAY-granular: gte(date, T) returns every
 * transaction whose calendar day >= T's day, regardless of T's time-of-day
 * (verified against the live API). So the incremental gte-resume re-fetches a
 * whole day of overlap, and the boundary dedup set must cover EVERY id on that
 * day — not just the latest timestamp/second within it.
 */
export const utcDay = (unix: number): string => unixToIso(unix).slice(0, 10)

// ─────────────────────────────────────────────────────────────────────────────
// (Subtlety 1) Boundary dedup — by id EQUALITY, never by id ordering.
//
// The rwa.xyz transaction `id` is a composite string
// `{network}-{txHash}-{logIndex}-{n}`. It is the field the fetch sorts on for
// deterministic pagination, but its order is LEXICAL-BY-HASH and therefore
// UNCORRELATED WITH TIME — id-ascending is not time-ascending. So an id can only
// be used as a unique equality key, never to decide "came before/after the
// cursor". (An earlier design compared ids as integers; the live API has no
// numeric id, which is what this redesign fixes.)
//
// The incremental pull resumes with gte(date, cursor.lastTxTimestamp). rwa.xyz's
// `date` filter is DAY-granular (verified live), so the re-fetch returns the whole
// UTC calendar day of the cursor onward — every transaction on the boundary day is
// returned again. The already-processed ones are exactly cursor.boundaryIds (the
// set of ids we recorded for that whole day last run); we drop those by id
// membership. Every other re-fetched row is genuinely new (a later day, or a
// same-day row that did not exist last run) and is kept.
//
//   • Drop too little → double-count → corrupt balances.
//   • Drop too much   → skip rows → undercount forever.
//
// On a full backfill (boundaryIds null/empty) nothing is dropped.
// ─────────────────────────────────────────────────────────────────────────────

export function dedupBoundary(
  transfers: RwaTransfer[],
  boundaryIds: string[] | null
): RwaTransfer[] {
  if (boundaryIds === null || boundaryIds.length === 0) return transfers
  const seen = new Set(boundaryIds)
  return transfers.filter((t) => !seen.has(t.id))
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge new (deduped) transactions into the balance map.
//
// Mint/burn null counterparties are already coerced to ZERO_ADDRESS upstream by
// normalizeTransaction, so the zero-address guards here exactly mirror
// computeBalances: a mint (from = zero) only credits the recipient; a burn
// (to = zero) only debits the sender. Balances are additive, so applying the
// post-cursor delta to a persisted pre-cursor balance equals a full replay.
//
// Exited holders are RETAINED, not dropped: when a balance reaches 0 the row is
// kept (balance 0) with its original firstReceipt intact (firstReceipt is the
// running min, so an existing receipt is never overwritten — incremental pulls
// only ever carry ts >= the persisted value). Preserving the zero row is what
// keeps netNewWallets90d byte-identical to a full replay: a wallet that fully
// exits and later RE-ENTERS still reports its true first-ever receipt, so it is
// not miscounted as net-new. (Classification consumes only the positive-balance
// subset — the orchestrator filters balance > 0 before calling the engine cores,
// matching computeBalances, which drops ≤ 0.) exitedWallets90d is derived from
// the bounded window pull, independent of this map.
// ─────────────────────────────────────────────────────────────────────────────

export function mergeTransfers(
  state: BalanceStateMap,
  transfers: RwaTransfer[],
  caseSensitive = false
): { merged: BalanceStateMap } {
  // Clone so the input map is not mutated (callers may reuse the loaded state).
  const merged: BalanceStateMap = new Map()
  for (const [addr, s] of state) merged.set(addr, { balance: s.balance, firstReceipt: s.firstReceipt })

  for (const t of transfers) {
    const from = normalizeAddress(t.from, caseSensitive)
    const to = normalizeAddress(t.to, caseSensitive)
    const value = BigInt(t.value)
    const ts = parseInt(t.timeStamp)

    if (to !== ZERO_ADDRESS) {
      const s = merged.get(to) ?? { balance: BigInt(0), firstReceipt: null }
      s.balance += value
      s.firstReceipt = s.firstReceipt === null ? ts : Math.min(s.firstReceipt, ts)
      merged.set(to, s)
    }
    if (from !== ZERO_ADDRESS) {
      const s = merged.get(from) ?? { balance: BigInt(0), firstReceipt: null }
      s.balance -= value
      merged.set(from, s)
    }
  }

  // Rows are retained at their true net balance (0 on a full exit). No deletion:
  // the zero row carries firstReceipt forward for any future re-entry.
  return { merged }
}

// ─────────────────────────────────────────────────────────────────────────────
// (Subtlety 2) New cursor = max TIMESTAMP over the deduped-new set, plus the set
// of ids on that timestamp's UTC calendar DAY (the day the next day-granular
// gte(date) will re-fetch in full).
//
// Computed from the NEW transactions only. If nothing new arrived, the cursor is
// unchanged (returns the prior cursor) so it never drifts on an empty run.
//
// boundaryIds must list EVERY processed id on the boundary DAY, or the next run
// will fail to dedup one and double-count it. The full-pagination pull means
// `newTransfers` already holds every row on the new max day — UNLESS the boundary
// day did not advance (max day == prior cursor's day), in which case last run
// already processed some ids on that day; those are in prior.boundaryIds and were
// deduped out of `newTransfers`, so we union them back in. The caller persists
// this AFTER the balance write succeeds (see orchestrator).
// ─────────────────────────────────────────────────────────────────────────────

export function computeNewCursor(
  newTransfers: RwaTransfer[],
  prior: FetchCursor | null
): FetchCursor | null {
  if (newTransfers.length === 0) return prior // nothing new ⇒ do not advance

  let maxTs = -Infinity
  for (const t of newTransfers) {
    const ts = parseInt(t.timeStamp)
    if (ts > maxTs) maxTs = ts
  }
  const maxDay = utcDay(maxTs)

  // Every id on the latest calendar DAY — that whole day is what the day-granular
  // gte(date) re-fetch returns next run, so all of it must be deduped then.
  const boundaryIds = new Set<string>()
  for (const t of newTransfers) {
    if (utcDay(parseInt(t.timeStamp)) === maxDay) boundaryIds.add(t.id)
  }

  // Latest day unchanged from last run: its already-processed ids were deduped out
  // of newTransfers but the gte(date) re-fetch still returns them, so carry forward.
  if (prior !== null && utcDay(isoToUnix(prior.lastTxTimestamp)) === maxDay) {
    for (const id of prior.boundaryIds) boundaryIds.add(id)
  }

  return { lastTxTimestamp: unixToIso(maxTs), boundaryIds: [...boundaryIds] }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator — injectable IO so the logic is testable offline.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload handed to the write-back. The implementation MUST persist the balance
 * upserts and the new cursor ATOMICALLY (all-or-nothing).
 *
 * Atomicity rationale: the additive merge is NOT idempotent, so balances and
 * cursor must advance together. If they could diverge — balances written, cursor
 * not — the next run would re-pull from the old cursor and re-merge the same
 * rows onto already-advanced balances, double-counting. The default write-back
 * therefore calls the apply_incremental_merge Postgres RPC, whose PL/pgSQL body
 * runs in a single transaction; on any error the whole write rolls back and the
 * cursor stays put, so the next run re-pulls and the boundary dedup absorbs the
 * overlap. Exited holders are kept as balance-0 rows (no deletes) so firstReceipt
 * survives a later re-entry.
 */
export interface WriteBackPayload {
  productSlug: string
  network: string
  merged: BalanceStateMap
  newCursor: FetchCursor | null
  classifications?: Map<string, HolderClassification>
  aggregateStats?: ReturnType<typeof computeAggregateStatsFromState>
}

export interface IncrementalDeps {
  loadCursor(productSlug: string, network: string): Promise<FetchCursor | null>
  loadState(productSlug: string, network: string): Promise<BalanceStateMap>
  /** All-time balance stream resumed from `sinceDate` (null ⇒ full pull). */
  fetchAllTimeSince(sinceDate: string | null): Promise<RwaTransfer[]>
  /** Bounded trailing-window pull (gte windowStart). */
  fetchWindow(sinceDate: string): Promise<RwaTransfer[]>
  writeBack(payload: WriteBackPayload): Promise<void>
}

export interface IncrementalParams {
  productSlug: string
  network: string
  /** 'per-wallet' writes holder rows; 'aggregate' computes aggregate stats only. */
  mode: 'per-wallet' | 'aggregate'
  nowTs?: number
  windowSeconds?: number
  /** True for case-sensitive address encodings (base58/base32 — Solana, XRPL,
   *  Stellar). When false (default, EVM/hex), holder addresses are lowercased to
   *  unify mixed-case. Must match the casing loadState/writeBack persist with. */
  caseSensitive?: boolean
}

export interface IncrementalResult {
  productSlug: string
  network: string
  fetchedCount: number
  newCount: number
  dedupedBoundaryCount: number
  merged: BalanceStateMap
  /** Positive-balance subset of `merged` — the exact holder set classified. */
  positive: BalanceStateMap
  /** The bounded trailing-window transfers fed to the engine cores. */
  windowTransfers: RwaTransfer[]
  newCursor: FetchCursor | null
  classifications?: Map<string, HolderClassification>
  aggregateStats?: ReturnType<typeof computeAggregateStatsFromState>
}

export async function runIncrementalFetchMerge(
  params: IncrementalParams,
  deps: IncrementalDeps
): Promise<IncrementalResult> {
  const { productSlug, network, mode } = params
  const nowTs = params.nowTs ?? Math.floor(Date.now() / 1000)
  const windowSeconds = params.windowSeconds ?? WINDOW_SECONDS
  const caseSensitive = params.caseSensitive ?? false

  // 1–2. Cursor + persisted state.
  const cursor = await deps.loadCursor(productSlug, network)
  const state = await deps.loadState(productSlug, network)

  // 3. Incremental all-time pull (gte cursor timestamp; full pull when null).
  const fetched = await deps.fetchAllTimeSince(cursor?.lastTxTimestamp ?? null)

  // 4. Drop the inclusive-gte boundary rows already processed last run.
  const newTransfers = dedupBoundary(fetched, cursor?.boundaryIds ?? null)

  // 8a. New cursor from the new set (persisted last, by the write-back).
  const newCursor = computeNewCursor(newTransfers, cursor)

  // 5. Merge into the balance map. Exited holders are retained as balance-0 rows.
  const { merged } = mergeTransfers(state, newTransfers, caseSensitive)

  // Classification consumes only the positive-balance subset (matches
  // computeBalances, which drops ≤ 0); the zero rows exist solely to preserve
  // firstReceipt across re-entry, so they must not be counted as holders.
  const positive: BalanceStateMap = new Map()
  for (const [addr, s] of merged) {
    if (s.balance > BigInt(0)) positive.set(addr, s)
  }

  // 6. Bounded trailing-window pull, independent of the cursor.
  const windowStartIso = unixToIso(nowTs - windowSeconds)
  const windowTransfers = await deps.fetchWindow(windowStartIso)

  // 7. Classify via the proven FromState cores (positive-balance holders only).
  let classifications: Map<string, HolderClassification> | undefined
  let aggregateStats: ReturnType<typeof computeAggregateStatsFromState> | undefined
  if (mode === 'per-wallet') {
    const balanceMap = new Map<string, bigint>()
    for (const [addr, s] of positive) balanceMap.set(addr, s.balance)
    classifications = classifyHoldersFromState(balanceMap, windowTransfers, nowTs, caseSensitive)
  } else {
    aggregateStats = computeAggregateStatsFromState(positive, windowTransfers, nowTs, caseSensitive)
  }

  // 8b. Persist balances + cursor atomically (see WriteBackPayload). The full
  // merged map (incl. retained zero rows) is written so firstReceipt is durable.
  await deps.writeBack({
    productSlug,
    network,
    merged,
    newCursor,
    classifications,
    aggregateStats,
  })

  return {
    productSlug,
    network,
    fetchedCount: fetched.length,
    newCount: newTransfers.length,
    dedupedBoundaryCount: fetched.length - newTransfers.length,
    merged,
    positive,
    windowTransfers,
    newCursor,
    classifications,
    aggregateStats,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Supabase-backed deps (the live wiring will use these). Kept here so
// the orchestrator stays pure/injectable and the parity gate can swap in fakes.
// ─────────────────────────────────────────────────────────────────────────────

export interface RwaFetchConfig {
  assetId: number
  networkId: number
  decimals: number
  tokenAddresses: string[]
  /** Case-sensitive address encoding (non-EVM). Threaded into loadState so the
   *  keys read back from holder_balance_state round-trip with the SAME casing the
   *  merge/write path used — must agree with IncrementalParams.caseSensitive. */
  caseSensitive?: boolean
}

/**
 * Build Supabase + rwa.xyz-backed deps for a (product, network). Imports
 * getSupabase lazily so importing this module never requires Supabase env in
 * test/offline contexts.
 */
export async function makeSupabaseDeps(
  config: RwaFetchConfig
): Promise<IncrementalDeps> {
  const { getSupabase } = await import('@/src/lib/supabase/client')

  return {
    async loadCursor(productSlug, network) {
      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('fetch_cursor')
        .select('last_tx_timestamp, boundary_tx_ids')
        .eq('product_slug', productSlug)
        .eq('network', network)
        .maybeSingle()
      if (error) throw new Error(`fetch_cursor read failed (${productSlug}/${network}): ${error.message}`)
      if (!data || data.last_tx_timestamp == null) return null
      return {
        lastTxTimestamp: data.last_tx_timestamp,
        boundaryIds: (data.boundary_tx_ids as string[] | null) ?? [],
      }
    },

    async loadState(productSlug, network) {
      const supabase = getSupabase()
      const map: BalanceStateMap = new Map()
      // PostgREST caps a SELECT at ~1000 rows by default, so the full holder set
      // must be paged — a product can have far more persisted rows than that
      // (positive holders + retained balance-0 exits). Ordered by address for
      // stable, non-overlapping ranges. balance::text forces the exact decimal
      // string (no float coercion — flag A).
      const PAGE = 1000
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('holder_balance_state')
          .select('address, balance::text, first_receipt')
          .eq('product_slug', productSlug)
          .eq('network', network)
          .order('address', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw new Error(`holder_balance_state read failed (${productSlug}/${network}): ${error.message}`)
        for (const row of data ?? []) {
          map.set(normalizeAddress(String(row.address), config.caseSensitive ?? false), {
            balance: parseNumericToBigInt(String(row.balance)),
            firstReceipt: row.first_receipt ? isoToUnix(row.first_receipt) : null,
          })
        }
        if (!data || data.length < PAGE) break
      }
      return map
    },

    async fetchAllTimeSince(sinceDate) {
      return fetchTransfersRWA(
        config.assetId,
        config.networkId,
        config.decimals,
        config.tokenAddresses,
        sinceDate ? { sinceDate } : {}
      )
    },

    async fetchWindow(sinceDate) {
      return fetchTransfersRWA(
        config.assetId,
        config.networkId,
        config.decimals,
        config.tokenAddresses,
        { sinceDate }
      )
    },

    async writeBack(payload) {
      const supabase = getSupabase()
      const { productSlug, network, merged, newCursor } = payload

      // Single atomic RPC: balances + cursor commit or roll back together
      // (apply_incremental_merge, one PL/pgSQL transaction). Balances serialized
      // as strings (flag A, write side); exited holders are retained as balance-0
      // rows by the upsert, never deleted. Sent as one call — batching across
      // multiple calls would break the all-or-nothing guarantee.
      const balances = Array.from(merged.entries()).map(([address, s]) => ({
        address,
        balance: serializeBalance(s.balance),
        first_receipt: s.firstReceipt === null ? null : unixToIso(s.firstReceipt),
      }))

      const { error } = await supabase.rpc('apply_incremental_merge', {
        p_product_slug: productSlug,
        p_network: network,
        p_balances: balances,
        p_last_tx_timestamp: newCursor?.lastTxTimestamp ?? null,
        p_boundary_tx_ids: newCursor?.boundaryIds ?? null,
      })
      if (error) throw new Error(`apply_incremental_merge RPC failed (${productSlug}/${network}): ${error.message}`)

      // NOTE: classification/aggregate writes would go here, reusing classify.ts's
      // upsert helpers — intentionally omitted until this layer is wired live.
    },
  }
}
