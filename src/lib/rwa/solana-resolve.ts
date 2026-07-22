/**
 * Solana ATA→owner resolution + twin dedup (B3).
 *
 * WHY. rwa.xyz /v4/transactions emits every Solana transfer through TWO parallel
 * feeds with distinct id schemes: dash (`2-<hash>-n`) keyed by the associated
 * token account (ATA), underscore (`2_<hash>_n_n`) keyed by the owner wallet.
 * Persisting both as-is double-counts positions and leaves orphaned-mint phantoms
 * (a mint present in both feeds whose burns land only in the owner feed — the ATA
 * copy never nets to zero). See _local/solana-ata-resolution-design.md.
 *
 * FIX. Resolve every ATA to its owner wallet (getAccountInfo), THEN dedup the twin
 * records that now coincide. After resolution every address is an owner, so the
 * orphaned mint's two copies collapse to one and the owner-feed burns net it to ~0.
 *
 * WHERE. Called from the fetch-layer pullers (fetchTransfersRWA /
 * fetchTransfersWindowRWA), GATED to Solana (networkId === SOLANA_NETWORK_ID) — no
 * other chain has the dual-feed, so every EVM path is byte-identical (never calls
 * this). Running here means merge keys, holder_balance_state, fetch_cursor boundary
 * ids, and classification all see owner addresses only.
 *
 * SCHEME → REPRESENTATION is 100%-clean on real data (probe 2026-07-21): every
 * dash address is an ATA, every underscore address is an owner; no address appears
 * in both. We use the id scheme ONLY to disambiguate a null account: a null
 * owner-feed address is an unfunded owner wallet (safe to keep); a null dash/ATA
 * address is a CLOSED ATA whose owner is unknowable — we FAIL LOUD rather than key
 * it raw (keying an unresolved address wrong is precisely the original bug).
 */

import type { RwaTransfer } from '@/src/lib/rwa/transfers'

/** rwa.xyz network_id for Solana — the only dual-feed chain. */
export const SOLANA_NETWORK_ID = 2

// Mint/burn counterparty sentinel — must match transfers.ts's ZERO_ADDRESS so a
// coerced mint (from) / burn (to) is skipped by resolution, not treated as a real
// address to look up.
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// SPL Token + Token-2022 program ids. An account owned by one of these whose
// parsed type is 'account' is a token account (ATA); its `info.owner` is the wallet.
const TOKEN_PROGRAM_IDS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
])

const DEFAULT_RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
]

/** RPC endpoints, overridable via SOLANA_RPC_URLS (comma-separated). */
function rpcEndpoints(): string[] {
  const env = process.env.SOLANA_RPC_URLS
  if (env) {
    const list = env.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length > 0) return list
  }
  return DEFAULT_RPC_ENDPOINTS
}

/**
 * Low-level account→owner lookup. For each address returns:
 *   • the owner wallet string, if it is a token account (ATA → its owner)
 *   • the address itself, if it is a system/other account (already an owner)
 *   • null, if the account does not exist on-chain (closed / unfunded)
 * Injectable so the resolve+dedup logic is testable offline.
 */
export type AccountOwnerLookup = (addresses: string[]) => Promise<Map<string, string | null>>

export interface ResolveOptions {
  /** Override the on-chain lookup (default: getMultipleAccounts over rpcEndpoints()). */
  lookup?: AccountOwnerLookup
}

interface ParsedAccount {
  owner: string
  data?: { parsed?: { type?: string; info?: { owner?: string } } }
}

const RPC_TIMEOUT_MS = 30_000
const RPC_ATTEMPTS_PER_ENDPOINT = 2

/** One getMultipleAccounts call (≤100 addresses) with endpoint fallback + retry.
 *  Throws if EVERY endpoint fails — resolution never guesses on RPC failure. */
async function getMultipleAccounts(addresses: string[], endpoints: string[]): Promise<(ParsedAccount | null)[]> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getMultipleAccounts',
    params: [addresses, { encoding: 'jsonParsed' }],
  })
  let lastErr: Error | null = null
  for (const url of endpoints) {
    for (let attempt = 0; attempt < RPC_ATTEMPTS_PER_ENDPOINT; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        })
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} from ${url}`)
          continue
        }
        const j = (await res.json()) as { result?: { value?: (ParsedAccount | null)[] }; error?: unknown }
        if (j.error) {
          lastErr = new Error(`RPC error from ${url}: ${JSON.stringify(j.error)}`)
          continue
        }
        if (j.result?.value) return j.result.value
        lastErr = new Error(`malformed getMultipleAccounts response from ${url}`)
      } catch (err) {
        lastErr = controller.signal.aborted ? new Error(`timeout after ${RPC_TIMEOUT_MS}ms from ${url}`) : (err as Error)
      } finally {
        clearTimeout(timeout)
      }
    }
  }
  throw new Error(
    `[solana-resolve] getMultipleAccounts failed on all ${endpoints.length} endpoint(s): ${lastErr?.message ?? 'unknown'}`
  )
}

/** Default lookup: batched getMultipleAccounts, token account → owner, else self,
 *  missing account → null (disambiguated by scheme in resolveAndDedupSolana). */
const defaultLookup: AccountOwnerLookup = async (addresses) => {
  const out = new Map<string, string | null>()
  if (addresses.length === 0) return out
  const endpoints = rpcEndpoints()
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100)
    const infos = await getMultipleAccounts(batch, endpoints)
    batch.forEach((addr, j) => {
      const v = infos[j]
      if (!v) {
        out.set(addr, null)
      } else if (TOKEN_PROGRAM_IDS.has(v.owner) && v.data?.parsed?.type === 'account' && v.data.parsed.info?.owner) {
        out.set(addr, v.data.parsed.info.owner) // ATA → owner wallet
      } else {
        out.set(addr, addr) // system/other account is already an owner wallet
      }
    })
  }
  return out
}

/**
 * Resolve every address in a Solana transfer set to its owner wallet, then dedup
 * the twin records that coincide after resolution. Returns a NEW array; the input
 * is not mutated. Per-run in-memory resolution only (no persistence — the mapping
 * is cheap to rederive and an ATA can close/reopen).
 *
 * Dedup key: (hash, resolvedFrom, resolvedTo, value). This includes the resolved
 * counterparties, so it collapses ATA/owner twins (identical after resolution) but
 * can never over-collapse two genuinely distinct owners paid an equal amount in one
 * tx (probe 2026-07-21: no such case exists in the live feeds — this is the strict-
 * superset-safe key regardless). Keep the min-`id` record so the surviving id is
 * DETERMINISTIC across runs, which keeps fetch_cursor.boundary_tx_ids stable.
 */
export async function resolveAndDedupSolana(
  transfers: RwaTransfer[],
  opts: ResolveOptions = {}
): Promise<RwaTransfer[]> {
  if (transfers.length === 0) return transfers
  const lookup = opts.lookup ?? defaultLookup

  // 1. distinct real addresses, each tagged with its feed scheme. 'owner' wins if
  //    an address is ever seen under the underscore feed (defensive — no address
  //    appears in both on real data, but this keeps a null null-safe).
  const schemeOf = new Map<string, 'ata' | 'owner'>()
  const addrs = new Set<string>()
  for (const t of transfers) {
    const scheme: 'ata' | 'owner' = t.id.includes('_') ? 'owner' : 'ata'
    for (const a of [t.from, t.to]) {
      if (!a || a === ZERO_ADDRESS) continue
      addrs.add(a)
      if (schemeOf.get(a) !== 'owner') schemeOf.set(a, scheme)
    }
  }

  // 2. resolve to owner, failing loud on an unresolvable ATA.
  const resolved = await lookup([...addrs])
  const ownerOf = new Map<string, string>()
  for (const a of addrs) {
    const r = resolved.get(a)
    if (r != null) {
      ownerOf.set(a, r)
    } else if (schemeOf.get(a) === 'owner') {
      ownerOf.set(a, a) // null owner-feed address = unfunded owner wallet — keep
    } else {
      throw new Error(
        `[solana-resolve] cannot resolve dash/ATA address ${a} — no on-chain account ` +
        `(closed ATA); refusing to key it raw (that reintroduces the double-count bug)`
      )
    }
  }
  const res = (a: string) => (!a || a === ZERO_ADDRESS ? a : (ownerOf.get(a) ?? a))

  // 3. rewrite counterparties + 4. dedup by resolved key, keep min-id (deterministic).
  const kept = new Map<string, RwaTransfer>()
  for (const t of transfers) {
    const from = res(t.from)
    const to = res(t.to)
    const key = `${t.hash} ${from} ${to} ${t.value}`
    const rewritten: RwaTransfer = { ...t, from, to }
    const cur = kept.get(key)
    if (!cur || t.id < cur.id) kept.set(key, rewritten)
  }
  return [...kept.values()]
}
