/**
 * Solana ATA→owner resolution + twin dedup (B3).
 *
 * WHY. rwa.xyz /v4/transactions emits every Solana transfer through TWO parallel
 * feeds with distinct id schemes: dash (`2-<hash>-n`) keyed by the associated
 * token account (ATA), underscore (`2_<hash>_m_n`) keyed by the owner wallet.
 * Persisting both as-is double-counts positions and leaves orphaned-mint phantoms
 * (a mint present in both feeds whose burns land only in the owner feed — the ATA
 * copy never nets to zero). See _local/solana-ata-resolution-design.md.
 *
 * FIX. Resolve every ATA to its owner wallet, THEN dedup the twin records that now
 * coincide. After resolution every address is an owner, so the orphaned mint's two
 * copies collapse to one and the owner-feed burns net it to ~0.
 *
 * WHERE. Called from the fetch-layer pullers (fetchTransfersRWA /
 * fetchTransfersWindowRWA), GATED to Solana (networkId === SOLANA_NETWORK_ID) — no
 * other chain has the dual-feed, so every EVM path is byte-identical (never calls
 * this). Running here means merge keys, holder_balance_state, fetch_cursor boundary
 * ids, and classification all see owner addresses only. Fetch-time placement is also
 * what makes FEED PAIRING possible at all: it consumes the raw dual-feed records,
 * which the merge layer never sees.
 *
 * ── Resolution ladder (first hit wins, per address) ──────────────────────────
 *   1. on-chain (getAccountInfo): token account → its owner; other account → itself
 *   2. null account + underscore/owner scheme → itself (an unfunded owner wallet)
 *   3. null account + dash/ATA scheme (a CLOSED ATA) → FEED PAIRING: the twin
 *      record under the other scheme names the same participant as an owner wallet
 *   4. …then the persisted solana_ata_owner map (a pairing learned on an earlier run)
 *   5. …then ONE bounded cross-window escalation (2 rwa.xyz requests for the whole
 *      unresolved set), because a closed ATA can be unpairable within a single day
 *      window yet trivially pairable from its other transactions
 *   6. …else FAIL LOUD. Keying an unresolved address raw is precisely the original
 *      double-count bug, so we refuse rather than guess.
 *
 * Steps 3-5 exist because rung 1 is TIME-DEPENDENT in a way history is not: an ATA
 * that resolved last month can be closed today, which retroactively breaks a window
 * that used to resolve. Pairing reads the answer out of the data we already fetched,
 * so it works on accounts that no longer exist. Probe 2026-09-10: pairing agreed with
 * getAccountInfo on 170 address-checks with 0 disagreements, and resolved 75 of 75
 * sampled closed ATAs.
 *
 * ⚠ The header formerly claimed SCHEME → REPRESENTATION is "100%-clean" — that a dash
 * address is always an ATA, an underscore address always an owner, and no address ever
 * appears under both. That is STALE (see design doc §A2): 2026-01-15 has 2 addresses
 * under both schemes, and 1-2 underscore-feed addresses per window are themselves live
 * token accounts. Both are handled — 'owner' wins in schemeOf, and the on-chain lookup
 * is unconditional — but do NOT build anything new on the old invariant. The scheme is
 * used for exactly one narrow job: disambiguating a null account.
 */

import type { RwaTransfer } from '@/src/lib/rwa/transfers'
import { getMultipleAccounts, rpcEndpoints } from '@/src/lib/rwa/solana-rpc'

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

/**
 * Low-level account→owner lookup. For each address returns:
 *   • the owner wallet string, if it is a token account (ATA → its owner)
 *   • the address itself, if it is a system/other account (already an owner)
 *   • null, if the account does not exist on-chain (closed / unfunded)
 * Injectable so the resolve+dedup logic is testable offline.
 */
export type AccountOwnerLookup = (addresses: string[]) => Promise<Map<string, string | null>>

/**
 * Persisted ATA→owner map (the `solana_ata_owner` table), carrying pairings learned
 * on earlier runs across the 3-hourly backfill slots.
 *
 * Only CLOSED ATAs are written: a live ATA is re-derived from chain every run, so
 * caching it buys nothing and a stale entry could only mislead. That also disposes of
 * the close-and-reopen-under-a-new-owner hazard — an entry can only ever be consulted
 * while the account is absent from chain, where the historical owner IS the answer.
 *
 * Both sides must degrade gracefully (log, return empty / no-op) rather than throw:
 * the table may not exist yet, and escalation still resolves the address without it.
 */
export interface AtaOwnerStore {
  load(atas: string[]): Promise<Map<string, string>>
  save(entries: ReadonlyArray<{ ata: string; owner: string }>): Promise<void>
}

/**
 * Bounded cross-window escalation. Given the dash addresses still unresolved after
 * pairing over the fetched set, return additional rwa.xyz records that mention them —
 * enough to pair from elsewhere in history. Implemented in transfers.ts; costs a fixed
 * couple of requests for the WHOLE unresolved set, not per address.
 */
export type EscalationFetch = (addresses: string[]) => Promise<RwaTransfer[]>

export interface ResolveOptions {
  /** Override the on-chain lookup (default: getMultipleAccounts over rpcEndpoints()). */
  lookup?: AccountOwnerLookup
  /** Persisted ATA→owner map. Omit to run without cross-run memory. */
  store?: AtaOwnerStore
  /** Cross-window escalation. Omit to fail loud as soon as in-window pairing misses. */
  escalate?: EscalationFetch
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

// ─────────────────────────────────────────────────────────────────────────────
// Feed pairing — read ATA→owner out of the dual feed itself.
// ─────────────────────────────────────────────────────────────────────────────

/** Which feed an id came from. Underscore ids carry '_'; dash ids never do. */
const schemeOfId = (id: string): 'ata' | 'owner' => (id.includes('_') ? 'owner' : 'ata')

/**
 * Trailing index component of a transaction id:
 *   dash        `2-<hash>-8`    → '8'
 *   underscore  `2_<hash>_4_8`  → '8'
 * Solana signatures are base58 (no '-' or '_'), so the last separator is unambiguous.
 * The value can be negative (`2_<hash>_3_-1` → '-1'), which is exactly the case the
 * (hash, value) fallback below exists to cover.
 */
function tailIndex(id: string): string {
  const sep = id.includes('_') ? '_' : '-'
  const i = id.lastIndexOf(sep)
  return i < 0 ? id : id.slice(i + 1)
}

export interface FeedPairing {
  /** dash/ATA address → the owner-feed address naming the same participant. */
  map: Map<string, string>
  /** Dash addresses whose twins named more than one owner — deliberately NOT mapped. */
  conflicts: string[]
}

/**
 * Derive ATA→owner from twin records: a dash record and an underscore record that
 * describe the same transfer leg name the same two participants under the two
 * representations, so their counterparties correspond POSITIONALLY (from↔from,
 * to↔to).
 *
 * Two join keys, applied in order and unioned:
 *   • `(hash, trailing index, value)` — the precise key.
 *   • `(hash, value)` — fallback, for the observed case where the tails disagree
 *     (dash `2-<hash>-0` pairs with underscore `2_<hash>_3_-1`). This can only fire
 *     where the hash holds exactly one dash and one underscore record at that value,
 *     so it never contradicts the precise key; it only fills in where the key missed.
 *
 * Only 1:1 groups are learned from. A group with several records on either side is
 * genuinely ambiguous (the dash feed's trailing index is NOT unique — see design doc
 * §A6), and multi-hop swap routes put several equal-amount legs in one transaction, so
 * pairing positionally inside such a group would invent mappings. They are skipped:
 * the addresses involved are learned from their other, unambiguous transactions
 * instead. Measured on the 2025-11-13 window: 1,558 of 1,564 dash records pair 1:1,
 * the 6 ambiguous ones are skipped, and all 66 dash addresses are still learned with
 * zero conflicts.
 *
 * An address is mapped only when every twin agrees on one owner; disagreement is
 * reported, never averaged or majority-voted.
 */
export function buildFeedPairingMap(transfers: readonly RwaTransfer[]): FeedPairing {
  const dashByKey = new Map<string, RwaTransfer[]>()
  const undByKey = new Map<string, RwaTransfer[]>()
  const dashByHash = new Map<string, RwaTransfer[]>()
  const undByHash = new Map<string, RwaTransfer[]>()

  const push = (m: Map<string, RwaTransfer[]>, k: string, t: RwaTransfer) => {
    const bucket = m.get(k)
    if (bucket) bucket.push(t)
    else m.set(k, [t])
  }

  for (const t of transfers) {
    const precise = `${t.hash}|${tailIndex(t.id)}|${t.value}`
    const fallback = `${t.hash}|${t.value}`
    if (schemeOfId(t.id) === 'owner') {
      push(undByKey, precise, t)
      push(undByHash, fallback, t)
    } else {
      push(dashByKey, precise, t)
      push(dashByHash, fallback, t)
    }
  }

  const candidates = new Map<string, Set<string>>()
  const note = (ata: string, owner: string) => {
    // Never map a coerced mint/burn sentinel, and never map an address to itself.
    if (!ata || !owner || ata === ZERO_ADDRESS || owner === ZERO_ADDRESS || ata === owner) return
    const seen = candidates.get(ata)
    if (seen) seen.add(owner)
    else candidates.set(ata, new Set([owner]))
  }

  for (const [dashGroups, undGroups] of [
    [dashByKey, undByKey],
    [dashByHash, undByHash],
  ] as const) {
    for (const [key, ds] of dashGroups) {
      const us = undGroups.get(key)
      if (!us || ds.length !== 1 || us.length !== 1) continue
      note(ds[0].from, us[0].from)
      note(ds[0].to, us[0].to)
    }
  }

  const map = new Map<string, string>()
  const conflicts: string[] = []
  for (const [ata, owners] of candidates) {
    if (owners.size === 1) map.set(ata, [...owners][0])
    else conflicts.push(`${ata} → {${[...owners].join(', ')}}`)
  }
  return { map, conflicts }
}

/** First transaction hash mentioning each address — for a diagnosable failure. */
function sampleHashes(transfers: readonly RwaTransfer[], addresses: readonly string[]): Map<string, string> {
  const want = new Set(addresses)
  const out = new Map<string, string>()
  for (const t of transfers) {
    for (const a of [t.from, t.to]) {
      if (a && want.has(a) && !out.has(a)) out.set(a, t.hash)
    }
    if (out.size === want.size) break
  }
  return out
}

/** Store access must never break a run that would otherwise resolve. */
async function safeStoreLoad(store: AtaOwnerStore, atas: string[]): Promise<Map<string, string>> {
  try {
    return await store.load(atas)
  } catch (err) {
    console.warn(`[solana-resolve] ata-owner store read failed (${(err as Error).message}) — continuing without it`)
    return new Map()
  }
}

async function safeStoreSave(store: AtaOwnerStore, entries: ReadonlyArray<{ ata: string; owner: string }>): Promise<void> {
  if (entries.length === 0) return
  try {
    await store.save(entries)
  } catch (err) {
    console.warn(`[solana-resolve] ata-owner store write failed (${(err as Error).message}) — mapping not persisted`)
  }
}

/**
 * Resolve every address in a Solana transfer set to its owner wallet, then dedup
 * the twin records that coincide after resolution. Returns a NEW array; the input
 * is not mutated.
 *
 * Dedup key: (hash, resolvedFrom, resolvedTo, value). This includes the resolved
 * counterparties, so it collapses ATA/owner twins (identical after resolution) but
 * can never over-collapse two genuinely distinct owners paid an equal amount in one
 * tx. Keep the min-`id` record so the surviving id is DETERMINISTIC across runs,
 * which keeps fetch_cursor.boundary_tx_ids stable.
 */
export async function resolveAndDedupSolana(
  transfers: RwaTransfer[],
  opts: ResolveOptions = {}
): Promise<RwaTransfer[]> {
  if (transfers.length === 0) return transfers
  const lookup = opts.lookup ?? defaultLookup

  // 1. distinct real addresses, each tagged with its feed scheme. 'owner' wins if
  //    an address is ever seen under the underscore feed — no longer merely
  //    defensive: addresses DO appear under both schemes (design doc §A2).
  const schemeOf = new Map<string, 'ata' | 'owner'>()
  const addrs = new Set<string>()
  for (const t of transfers) {
    const scheme = schemeOfId(t.id)
    for (const a of [t.from, t.to]) {
      if (!a || a === ZERO_ADDRESS) continue
      addrs.add(a)
      if (schemeOf.get(a) !== 'owner') schemeOf.set(a, scheme)
    }
  }

  // 2. pairing derived from the fetched set, and the on-chain truth.
  const pairing = buildFeedPairingMap(transfers)
  const resolved = await lookup([...addrs])

  // 3. ladder rungs 1-3. `viaTwin` holds an owner-FEED address, which is not yet
  //    guaranteed to be an owner WALLET — it is chased through the lookup in step 6.
  const ownerOf = new Map<string, string>()
  const viaTwin = new Map<string, string>()
  let pending: string[] = []
  for (const a of addrs) {
    const r = resolved.get(a)
    if (r != null) {
      ownerOf.set(a, r)
    } else if (schemeOf.get(a) === 'owner') {
      ownerOf.set(a, a) // null owner-feed address = unfunded owner wallet — keep
    } else {
      const twin = pairing.map.get(a) // closed ATA — recover the owner from its twin
      if (twin) viaTwin.set(a, twin)
      else pending.push(a)
    }
  }

  // 4. rung 4 — a pairing learned on an earlier run.
  const fromStore = new Set<string>()
  if (pending.length > 0 && opts.store) {
    const stored = await safeStoreLoad(opts.store, pending)
    for (const [ata, owner] of stored) {
      viaTwin.set(ata, owner)
      fromStore.add(ata)
    }
    pending = pending.filter((a) => !stored.has(a))
  }

  // 5. rung 5 — ONE bounded escalation for the whole remaining set. A closed ATA can
  //    be unpairable inside a single day window yet pair trivially from its other
  //    transactions, so widen the pairing corpus rather than failing on a window
  //    boundary artifact.
  if (pending.length > 0 && opts.escalate) {
    const extra = await opts.escalate(pending)
    if (extra.length > 0) {
      const wider = buildFeedPairingMap([...transfers, ...extra])
      pending = pending.filter((a) => {
        const twin = wider.map.get(a)
        if (!twin) return true
        viaTwin.set(a, twin)
        return false
      })
    }
  }

  // 6. rung 6 — fail loud, naming every address and a transaction to look at.
  if (pending.length > 0) {
    const samples = sampleHashes(transfers, pending)
    const lines = pending.map((a) => `  ${a}  (sample tx ${samples.get(a) ?? 'unknown'})`).join('\n')
    const conflictNote =
      pairing.conflicts.length > 0
        ? `\nPairing found CONFLICTING owners for ${pairing.conflicts.length} other address(es):\n  ${pairing.conflicts.join('\n  ')}`
        : ''
    throw new Error(
      `[solana-resolve] cannot resolve ${pending.length} dash/ATA address(es) — no on-chain ` +
      `account (closed ATA), no underscore-feed twin in this window, no persisted mapping, and ` +
      `cross-window escalation ${opts.escalate ? 'found none' : 'was not configured'}. Refusing to ` +
      `key them raw (that reintroduces the double-count bug):\n${lines}${conflictNote}`
    )
  }

  // 7. chase every twin through the lookup: the owner-feed address may itself be a
  //    live token account (1-2 per window — design doc §A2), and keying one would
  //    leave an ATA in the balance state. A twin already looked up in step 2 reuses
  //    that result; only twins outside the fetched set cost a second call.
  const needChase = [...new Set(viaTwin.values())].filter((t) => !resolved.has(t))
  const chased = needChase.length > 0 ? await lookup(needChase) : new Map<string, string | null>()
  for (const [ata, twin] of viaTwin) {
    const r = resolved.has(twin) ? resolved.get(twin)! : (chased.get(twin) ?? null)
    ownerOf.set(ata, r ?? twin) // a null twin is an unfunded/closed owner wallet — keep it
  }

  if (viaTwin.size > 0) {
    console.log(
      `[solana-resolve] recovered ${viaTwin.size} closed ATA(s) by feed pairing` +
      (fromStore.size > 0 ? ` (${fromStore.size} from the persisted map)` : '')
    )
    // Persist only what pairing had to derive — a live ATA is re-read from chain
    // every run, so only the unreadable (closed) ones are worth remembering.
    if (opts.store) {
      const fresh = [...viaTwin.keys()]
        .filter((ata) => !fromStore.has(ata))
        .map((ata) => ({ ata, owner: ownerOf.get(ata)! }))
      await safeStoreSave(opts.store, fresh)
    }
  }

  const res = (a: string) => (!a || a === ZERO_ADDRESS ? a : (ownerOf.get(a) ?? a))

  // 8. rewrite counterparties + dedup by resolved key, keep min-id (deterministic).
  const kept = new Map<string, RwaTransfer>()
  for (const t of transfers) {
    const from = res(t.from)
    const to = res(t.to)
    const key = `${t.hash} ${from} ${to} ${t.value}`
    const rewritten: RwaTransfer = { ...t, from, to }
    const cur = kept.get(key)
    if (!cur || t.id < cur.id) kept.set(key, rewritten)
  }
  return [...kept.values()]
}
