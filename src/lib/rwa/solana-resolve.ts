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
 *   1. on-chain (getAccountInfo): token account of THIS fund's mint → its owner;
 *      any other account (a wallet, or a token account of some other mint) → itself
 *   2. null account + underscore/owner scheme → itself (an unfunded owner wallet)
 *   3. null account + dash/ATA scheme (a CLOSED ATA) → a CANDIDATE from FEED PAIRING:
 *      the twin record under the other scheme names the same participant
 *   4. …or from the persisted solana_ata_owner map (learned on an earlier run)
 *   5. …or from ONE bounded cross-window escalation (2 rwa.xyz requests for the
 *      whole unresolved set), because a closed ATA can be unpairable within a single
 *      day window yet trivially pairable from its other transactions
 *   6. PROOF — a candidate is never keyed on the feed's word alone:
 *      a. derivation: the ATA is re-derived from (candidate, mint); a match is proof
 *         (an ATA address is a pure function of its owner — solana-ata.ts). Free.
 *      b. otherwise TRACE: the owner is read from the account's own transaction on
 *         chain (token-balance owner field at the time of the transfer), which works
 *         for closed accounts and settles auxiliary (non-associated) accounts.
 *         Addresses with NO candidate at all go straight here.
 *   7. …else FAIL LOUD. Keying an unresolved address raw is precisely the original
 *      double-count bug, so we refuse rather than guess.
 *
 * Steps 3-5 exist because rung 1 is TIME-DEPENDENT in a way history is not: an ATA
 * that resolved last month can be closed today, which retroactively breaks a window
 * that used to resolve. Pairing reads the answer out of the data we already fetched,
 * so it works on accounts that no longer exist.
 *
 * Step 6 exists because pairing's premise — "the underscore record names the token
 * account's OWNER" — is false for delegate-operated accounts (investigation
 * 2026-09-20). A token account owned by a program PDA and moved by an approved
 * delegate is reported under the transaction SIGNER, a fresh throwaway wallet each
 * time: AXzpX8… paired to three different "owners" in one window, none of them the
 * real one (3YcoFh…). Multiple twins at least surface as a conflict; a single twin
 * would have been keyed and persisted wrong with nothing to flag it. Derivation
 * rejects every such claim for free, and the trace supplies the truth. It also
 * replaces the former "chase" step, which re-resolved a pairing twin through CURRENT
 * chain state and produced the one wrong row in 2,790 persisted mappings (the twin
 * wallet had since become a wrapped-SOL token account owned by someone else).
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
import { getMultipleAccounts, getTransaction, ownerOfAccountInTransaction, rpcEndpoints } from '@/src/lib/rwa/solana-rpc'
import { isAssociatedTokenAccountOf } from '@/src/lib/rwa/solana-ata'
import { transferRecordKey } from '@/src/lib/rwa/record-key'

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
 * A stored row is a CANDIDATE like any other: it goes through step 6 on every use, and
 * a row the proof overturns is re-saved corrected (upsert on the ata key).
 *
 * Both sides must degrade gracefully (log, return empty / no-op) rather than throw:
 * the table may not exist yet, and the trace still resolves the address without it.
 */
export interface AtaOwnerStore {
  load(atas: string[]): Promise<Map<string, string>>
  save(entries: ReadonlyArray<{ ata: string; owner: string; source?: string }>): Promise<void>
}

/**
 * Bounded cross-window escalation. Given the dash addresses still unresolved after
 * pairing over the fetched set, return additional rwa.xyz records that mention them —
 * enough to pair from elsewhere in history. Implemented in transfers.ts; costs a fixed
 * couple of requests for the WHOLE unresolved set, not per address. May overlap the
 * window's own records; the resolver dedups the union by id.
 */
export type EscalationFetch = (addresses: string[]) => Promise<RwaTransfer[]>

/**
 * Owner-at-transaction trace (step 6b). For each (address, hash) returns the owner of
 * `address` as transaction `hash` records it, or null when that transaction does not
 * establish one. Default: chain, via getTransaction + ownerOfAccountInTransaction.
 * Injectable; pass null to run with no trace at all (offline tests).
 */
export type OwnerTrace = (
  requests: ReadonlyArray<{ address: string; hash: string }>
) => Promise<Map<string, string | null>>

export interface ResolveOptions {
  /** Override the on-chain lookup (default: getMultipleAccounts over rpcEndpoints(),
   *  scoped to `mints` when given). */
  lookup?: AccountOwnerLookup
  /** Persisted ATA→owner map. Omit to run without cross-run memory. */
  store?: AtaOwnerStore
  /** Cross-window escalation. Omit to skip rung 5. */
  escalate?: EscalationFetch
  /**
   * This fund's mint(s) on Solana — what derivation proof (6a) needs. Production
   * always passes it (transfers.ts: the configured token address IS the mint). Without
   * it no candidate can be proven, and a candidate is then accepted on the feed's word
   * with a warning — acceptable only for offline callers with synthetic addresses.
   */
  mints?: readonly string[]
  /** Owner trace (6b). Default: chain. `null` disables it (offline tests). */
  trace?: OwnerTrace | null
}

/**
 * Default lookup: batched getMultipleAccounts. A token account of one of `mints` →
 * its owner; anything else → itself; missing account → null (disambiguated by scheme
 * in resolveAndDedupSolana).
 *
 * The mint scope matters: an owner-feed WALLET can, by the time the resolver runs,
 * have become a token account of some unrelated mint (9SJ6qjuG… is now a wrapped-SOL
 * account — 2026-09-20). It held this fund's position as a wallet, so it must stay
 * keyed as itself; only a token account of THIS mint is a position we need to lift to
 * its owner. With no mints given, every token account is lifted (the pre-2026-09-20
 * behaviour).
 */
function makeDefaultLookup(mints: readonly string[]): AccountOwnerLookup {
  const mintSet = new Set(mints)
  return async (addresses) => {
    const out = new Map<string, string | null>()
    if (addresses.length === 0) return out
    const endpoints = rpcEndpoints()
    for (let i = 0; i < addresses.length; i += 100) {
      const batch = addresses.slice(i, i + 100)
      const infos = await getMultipleAccounts(batch, endpoints)
      batch.forEach((addr, j) => {
        const v = infos[j]
        const info = v?.data?.parsed?.info
        if (!v) {
          out.set(addr, null)
        } else if (
          TOKEN_PROGRAM_IDS.has(v.owner) && v.data?.parsed?.type === 'account' && info?.owner &&
          (mintSet.size === 0 || (info.mint !== undefined && mintSet.has(info.mint)))
        ) {
          out.set(addr, info.owner) // this fund's token account → owner wallet
        } else {
          out.set(addr, addr) // wallet, program account, or another mint's account: already a key
        }
      })
    }
    return out
  }
}

/** Default trace: one getTransaction per address, sequential (few per window). */
const defaultTrace: OwnerTrace = async (requests) => {
  const out = new Map<string, string | null>()
  if (requests.length === 0) return out
  const endpoints = rpcEndpoints()
  for (const { address, hash } of requests) {
    const tx = await getTransaction(hash, endpoints)
    out.set(address, tx ? ownerOfAccountInTransaction(tx, address) : null)
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
  /** Every 1:1 twin pair found, [dash record, underscore record] — the dedup step's
   *  twin repair reads these. */
  pairs: Array<[RwaTransfer, RwaTransfer]>
}

/**
 * Derive ATA→owner CANDIDATES from twin records: a dash record and an underscore
 * record that describe the same transfer leg name the same two participants under the
 * two representations, so their counterparties correspond POSITIONALLY (from↔from,
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
 * zero conflicts. Feed the function DISTINCT records: a duplicated record turns every
 * group it sits in into a 2:1 and silently suppresses that pairing.
 *
 * An address is mapped only when every twin agrees on one owner; disagreement is
 * reported, never averaged or majority-voted. The result is a CANDIDATE — the
 * underscore feed names the transaction signer, not the owner, for delegate-operated
 * accounts — and is proven or replaced in resolveAndDedupSolana step 6.
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

  const pairs: Array<[RwaTransfer, RwaTransfer]> = []
  const paired = new Set<string>()
  for (const [dashGroups, undGroups] of [
    [dashByKey, undByKey],
    [dashByHash, undByHash],
  ] as const) {
    for (const [key, ds] of dashGroups) {
      const us = undGroups.get(key)
      if (!us || ds.length !== 1 || us.length !== 1) continue
      note(ds[0].from, us[0].from)
      note(ds[0].to, us[0].to)
      const pk = `${ds[0].id}|${us[0].id}`
      if (!paired.has(pk)) {
        paired.add(pk)
        pairs.push([ds[0], us[0]])
      }
    }
  }

  const map = new Map<string, string>()
  const conflicts: string[] = []
  for (const [ata, owners] of candidates) {
    if (owners.size === 1) map.set(ata, [...owners][0])
    else conflicts.push(`${ata} → {${[...owners].join(', ')}}`)
  }
  return { map, conflicts, pairs }
}

/** First transaction hash mentioning each address — the trace's input, and a
 *  diagnosable failure's. */
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

async function safeStoreSave(store: AtaOwnerStore, entries: ReadonlyArray<{ ata: string; owner: string; source?: string }>): Promise<void> {
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
  const mints = opts.mints ?? []
  const lookup = opts.lookup ?? makeDefaultLookup(mints)
  const trace = opts.trace === undefined ? defaultTrace : opts.trace

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

  // 3. ladder rungs 1-3. `candidate` holds a CLAIMED owner (an owner-feed address),
  //    proven or replaced in step 6 before it is keyed.
  const ownerOf = new Map<string, string>()
  const candidate = new Map<string, string>()
  let pending: string[] = []
  for (const a of addrs) {
    const r = resolved.get(a)
    if (r != null) {
      ownerOf.set(a, r)
    } else if (schemeOf.get(a) === 'owner') {
      ownerOf.set(a, a) // null owner-feed address = unfunded owner wallet — keep
    } else {
      const twin = pairing.map.get(a) // closed ATA — a candidate from its twin
      if (twin) candidate.set(a, twin)
      else pending.push(a)
    }
  }

  // 4. rung 4 — a mapping learned on an earlier run. Remembered so a row the proof
  //    overturns can be re-saved corrected, and an unchanged one not re-written.
  const storedOwner = new Map<string, string>()
  if (pending.length > 0 && opts.store) {
    const stored = await safeStoreLoad(opts.store, pending)
    for (const [ata, owner] of stored) {
      candidate.set(ata, owner)
      storedOwner.set(ata, owner)
    }
    pending = pending.filter((a) => !stored.has(a))
  }

  // 5. rung 5 — ONE bounded escalation for the whole remaining set. A closed ATA can
  //    be unpairable inside a single day window yet pair trivially from its other
  //    transactions, so widen the pairing corpus rather than failing on a window
  //    boundary artifact. The union is deduplicated by id: escalation re-returns the
  //    window's own records for the shared hashes, and a duplicate turns every 1:1
  //    pairing group it sits in into a 2:1 that buildFeedPairingMap must skip.
  if (pending.length > 0 && opts.escalate) {
    const extra = await opts.escalate(pending)
    if (extra.length > 0) {
      // Full record identity, not the id: a dash id can be shared by two distinct
      // records (design doc §A6), and both are needed for pairing.
      const seen = new Set(transfers.map(transferRecordKey))
      const fresh = extra.filter((t) => {
        const k = transferRecordKey(t)
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      const wider = buildFeedPairingMap([...transfers, ...fresh])
      pending = pending.filter((a) => {
        const twin = wider.map.get(a)
        if (!twin) return true
        candidate.set(a, twin)
        return false
      })
    }
  }

  // 6. PROOF. Every candidate must derive as the ATA of its claimed owner for one of
  //    this fund's mints (6a). One that does not — an auxiliary account, or a delegate-
  //    operated one the feed reported under its signer — and every address with no
  //    candidate at all, is settled from its own transaction on chain (6b).
  const proven = new Map<string, { owner: string; source: 'pairing' | 'trace' }>()
  const toTrace: string[] = [...pending]
  const unprovable: string[] = []
  for (const [ata, claimed] of candidate) {
    if (mints.length > 0 && isAssociatedTokenAccountOf(ata, claimed, mints)) {
      proven.set(ata, { owner: claimed, source: 'pairing' })
    } else if (trace || mints.length > 0) {
      toTrace.push(ata) // a mismatch with no trace fails loud below — never keyed on trust
    } else {
      proven.set(ata, { owner: claimed, source: 'pairing' })
      unprovable.push(ata)
    }
  }
  if (unprovable.length > 0) {
    console.warn(`[solana-resolve] no mints configured — ${unprovable.length} pairing candidate(s) accepted WITHOUT derivation proof`)
  }

  const samples = sampleHashes(transfers, toTrace)
  const failed: string[] = []
  let overturned = 0
  if (toTrace.length > 0) {
    const traced = trace
      ? await trace(toTrace.map((address) => ({ address, hash: samples.get(address) ?? '' })))
      : new Map<string, string | null>()
    for (const a of toTrace) {
      const owner = traced.get(a)
      if (!owner) {
        failed.push(a)
        continue
      }
      proven.set(a, { owner, source: 'trace' })
      const claimed = candidate.get(a)
      if (claimed && claimed !== owner) {
        overturned++
        console.warn(
          `[solana-resolve] feed claimed ${a} → ${claimed} (${storedOwner.has(a) ? 'persisted row' : 'pairing'}); ` +
          `chain says ${owner} (tx ${samples.get(a)}) — corrected`
        )
      }
    }
  }

  // 7. fail loud, naming every address, a transaction to look at, and what was tried.
  if (failed.length > 0) {
    const lines = failed
      .map((a) => `  ${a}  (sample tx ${samples.get(a) ?? 'unknown'}${candidate.has(a) ? `; feed claimed ${candidate.get(a)}, not proven` : '; no twin'})`)
      .join('\n')
    const conflictNote =
      pairing.conflicts.length > 0
        ? `\nPairing found CONFLICTING owners for ${pairing.conflicts.length} other address(es):\n  ${pairing.conflicts.join('\n  ')}`
        : ''
    const tried = [
      'no on-chain account (closed ATA)',
      'no proven underscore-feed twin in this window',
      'no proven persisted mapping',
      `cross-window escalation ${opts.escalate ? 'found none' : 'was not configured'}`,
      trace ? 'and the sample transaction names no owner for it' : 'and no owner trace was configured',
    ].join(', ')
    throw new Error(
      `[solana-resolve] cannot resolve ${failed.length} dash/ATA address(es) — ${tried}. Refusing to ` +
      `key them raw (that reintroduces the double-count bug):\n${lines}${conflictNote}`
    )
  }

  for (const [ata, { owner }] of proven) ownerOf.set(ata, owner)

  if (proven.size > 0) {
    let byPairing = 0
    let byTrace = 0
    let fromStore = 0
    for (const [ata, { source }] of proven) {
      if (source === 'pairing') byPairing++
      else byTrace++
      if (storedOwner.has(ata)) fromStore++
    }
    console.log(
      `[solana-resolve] recovered ${proven.size} closed ATA(s): ${byPairing} proven by derivation` +
      (fromStore > 0 ? ` (${fromStore} via the persisted map)` : '') +
      (byTrace > 0 ? `, ${byTrace} traced on chain` : '') +
      (overturned > 0 ? ` — ${overturned} feed claim(s) overturned` : '')
    )
    // Persist what this run established: new mappings, and stored rows the proof
    // corrected. A stored row that held up is not re-written.
    if (opts.store) {
      const entries = [...proven]
        .filter(([ata, { owner }]) => storedOwner.get(ata) !== owner)
        .map(([ata, { owner, source }]) => ({ ata, owner, source }))
      await safeStoreSave(opts.store, entries)
    }
  }

  const res = (a: string) => (!a || a === ZERO_ADDRESS ? a : (ownerOf.get(a) ?? a))

  // 8a. twin repair. Within a 1:1 twin pair the two feeds describe ONE transfer leg,
  //     and the dash record's participants are now chain-resolved (or proven). Where
  //     the underscore twin names someone else it is the feed's mislabel — a delegate-
  //     operated transfer reported under its SIGNER — and left alone it would survive
  //     the dedup as a second record keyed to a wallet that never held the position.
  //     Rewrite that side of the twin to the dash record's resolution so the pair
  //     collapses. This fires ONLY where the feeds disagree after resolution, which on
  //     the validated windows (170 address-checks, 0 disagreements) is never.
  const twinRepair = new Map<string, { from: string; to: string }>()
  for (const [d, u] of pairing.pairs) {
    const from = res(d.from)
    const to = res(d.to)
    if (from !== res(u.from) || to !== res(u.to)) twinRepair.set(u.id, { from, to })
  }
  if (twinRepair.size > 0) {
    console.log(`[solana-resolve] repaired ${twinRepair.size} underscore twin(s) that named a participant the ATA feed's chain resolution contradicts (delegate-signed transfers)`)
  }

  // 8b. rewrite counterparties + dedup by resolved key, keep min-id (deterministic).
  const kept = new Map<string, RwaTransfer>()
  for (const t of transfers) {
    const repair = twinRepair.get(t.id)
    const from = repair ? repair.from : res(t.from)
    const to = repair ? repair.to : res(t.to)
    const key = `${t.hash} ${from} ${to} ${t.value}`
    const rewritten: RwaTransfer = { ...t, from, to }
    const cur = kept.get(key)
    if (!cur || t.id < cur.id) kept.set(key, rewritten)
  }
  return [...kept.values()]
}
