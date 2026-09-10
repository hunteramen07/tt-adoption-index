/**
 * npm run test:solana-resolve
 *
 * Offline gate for the Solana ATA→owner resolution + twin dedup (B3,
 * src/lib/rwa/solana-resolve.ts). Runs with an INJECTED account lookup seeded from
 * the four confirmed ATA↔owner pairings (design doc §2a) — no network, no DB,
 * deterministic. Proves:
 *
 *   1. rewrite     — ATA counterparties are rewritten to their owner wallet
 *   2. collapse    — dual-feed twins (same hash+amount under dash+underscore)
 *                    dedup to ONE record after resolution
 *   3. orphan→0    — a mint present in both feeds whose burns are owner-feed-only
 *                    nets the owner to exactly 0 (the 26.9M phantom, in miniature)
 *   4. no-over-collapse — two DISTINCT txs (different hash) of equal amount to the
 *                    same owner are NOT collapsed
 *   5. deterministic — keep-min-id picks the same survivor regardless of input order
 *   6. fail-loud   — a null DASH/ATA address throws; a null UNDERSCORE/owner
 *                    address is kept (unfunded owner wallet)
 *   7. ladder      — a closed ATA is recovered by FEED PAIRING; then by the persisted
 *                    store; then by cross-window escalation; and only then fails loud,
 *                    naming every unresolvable address and a sample tx
 *   8. REAL DATA   — the captured 2025-11-13 USDY Solana window (the exact window the
 *                    backfill froze on): 3,129 records, 66 dash addresses of which 14
 *                    are closed ATAs. Asserts all 66 resolve, that pairing agrees with
 *                    on-chain truth on all 52 live ATAs, that the 1,564 dash records
 *                    collapse onto their twins, and that no live ATA survives as a key.
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  resolveAndDedupSolana,
  buildFeedPairingMap,
  type AccountOwnerLookup,
  type AtaOwnerStore,
  type EscalationFetch,
} from '@/src/lib/rwa/solana-resolve'
import type { RwaTransfer } from '@/src/lib/rwa/transfers'

const ZERO = '0x0000000000000000000000000000000000000000'

let failures = 0
const ok = (m: string) => console.log(`  ✓ ${m}`)
const fail = (m: string) => {
  failures++
  console.error(`  ✗ ${m}`)
}
const expect = (label: string, cond: boolean, detail = '') =>
  cond ? ok(label) : fail(`${label}${detail ? ` — ${detail}` : ''}`)

// The four confirmed pairings (dash ATA ↔ underscore owner).
const ATA = ['37Fz5gkifNwSe61SChizggKgA2zp5FR6dF7SmCtjb7BP',
             '3JghPkSoYGu4UvRQufrFw1GPj2A8pgMhFbcKXeHYc4Ay',
             '2wVbKHeEyYqscLiDS8C4HaGmusVFWyYbL3Vs6PyNng71',
             'FutxeSUS9iqZKY9LquntvqdjtUFfYyLgT93xu8bztFz']
const OWNER = ['85syE1SzSzx1ZoiNgTFoC8mRHwz88q98p8taNXVGfaJH',
               'Cyv8hDAQp4nVUmrsMiCYcY9vezEqDmEgfmyGmY8kyQhf',
               'Cj2D9dZiVviLZ5nkwe1MKWZtvNBE6h1tb9XvYQi2R8Kz',
               'CdXsroa8yDE7XuQRekZh1CdhY2nQueFcfsQmT8HA9vYF']
const NULL_DASH_ATA = 'CLOSEDddddddddddddddddddddddddddddddddddddd'   // a closed ATA (lookup → null)
const NULL_OWNER = 'UNFUNDEDwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww'      // an unfunded owner (lookup → null)

const ataToOwner = new Map(ATA.map((a, i) => [a, OWNER[i]]))
const owners = new Set(OWNER)

/** Fake lookup: ATA → owner, owner → self, the two null accounts → null, anything
 *  else → self. Mirrors getMultipleAccounts semantics offline. */
const fakeLookup: AccountOwnerLookup = async (addresses) => {
  const m = new Map<string, string | null>()
  for (const a of addresses) {
    if (ataToOwner.has(a)) m.set(a, ataToOwner.get(a)!)
    else if (a === NULL_DASH_ATA || a === NULL_OWNER) m.set(a, null)
    else if (owners.has(a)) m.set(a, a)
    else m.set(a, a)
  }
  return m
}

/** Minimal RwaTransfer; only id/hash/from/to/value carry meaning for resolution. */
function mk(id: string, hash: string, from: string, to: string, value: string): RwaTransfer {
  return {
    id, from, to, value, hash,
    timeStamp: '1700000000', blockNumber: '0', nonce: '', blockHash: '', contractAddress: '',
    tokenName: '', tokenSymbol: '', tokenDecimal: '', transactionIndex: '', gas: '', gasPrice: '',
    gasUsed: '', cumulativeGasUsed: '', input: '', confirmations: '',
  }
}
// id scheme: dash '2-<hash>-n' = ATA feed; underscore '2_<hash>_1_n' = owner feed.
const dash = (hash: string, from: string, to: string, value: string, n = 0) => mk(`2-${hash}-${n}`, hash, from, to, value)
const under = (hash: string, from: string, to: string, value: string, n = 0) => mk(`2_${hash}_1_${n}`, hash, from, to, value)

/** Net balance per address from a resolved+deduped set (mints +to, burns −from). */
function replay(ts: RwaTransfer[]): Map<string, number> {
  const bal = new Map<string, number>()
  for (const t of ts) {
    if (t.to && t.to !== ZERO) bal.set(t.to, (bal.get(t.to) ?? 0) + Number(t.value))
    if (t.from && t.from !== ZERO) bal.set(t.from, (bal.get(t.from) ?? 0) - Number(t.value))
  }
  return bal
}

async function main() {
  console.log('=== solana-resolve parity (injected lookup, four pairings) ===\n')

  // 1. rewrite — a dash mint to ATA[0] becomes a mint to OWNER[0].
  {
    const out = await resolveAndDedupSolana([dash('h1', ZERO, ATA[0], '1000000')], { lookup: fakeLookup })
    expect('rewrite: ATA → owner on `to`', out.length === 1 && out[0].to === OWNER[0], `got to=${out[0]?.to}`)
    expect('rewrite: mint `from` stays zero-address', out[0]?.from === ZERO)
  }

  // 2. collapse — same mint under both feeds dedups to one owner-keyed record.
  {
    const out = await resolveAndDedupSolana(
      [dash('h2', ZERO, ATA[1], '5000000'), under('h2', ZERO, OWNER[1], '5000000')],
      { lookup: fakeLookup }
    )
    expect('collapse: dual-feed twin → 1 record', out.length === 1, `got ${out.length}`)
    expect('collapse: survivor keyed on owner', out[0]?.to === OWNER[1])
  }

  // 3. orphan → 0 — mint in both feeds, burns owner-feed-only, owner nets to zero.
  {
    const input = [
      dash('h3', ZERO, ATA[0], '1000000'),    // mint (ATA feed)
      under('h3', ZERO, OWNER[0], '1000000'),  // mint (owner feed) — twin of above
      under('h6', OWNER[0], ZERO, '600000'),   // burn (owner feed only)
      under('h7', OWNER[0], ZERO, '400000'),   // burn (owner feed only)
    ]
    const out = await resolveAndDedupSolana(input, { lookup: fakeLookup })
    const bal = replay(out)
    expect('orphan→0: twin mint deduped', out.length === 3, `got ${out.length}`)
    expect('orphan→0: owner nets to exactly 0', bal.get(OWNER[0]) === 0, `got ${bal.get(OWNER[0])}`)
  }

  // 4. no over-collapse — two DISTINCT txs (different hash), equal amount, same owner.
  {
    const out = await resolveAndDedupSolana(
      [dash('h8', ZERO, ATA[2], '250000'), dash('h9', ZERO, ATA[2], '250000')],
      { lookup: fakeLookup }
    )
    expect('no-over-collapse: distinct hashes kept separate', out.length === 2, `got ${out.length}`)
  }

  // 5. deterministic — keep-min-id survivor is order-independent. Dash id '2-h2-0'
  //    < underscore id '2_h2_1_0' ('-' 0x2D < '_' 0x5F), so the dash id must win
  //    regardless of input order.
  {
    const a = dash('h2', ZERO, ATA[1], '5000000')
    const b = under('h2', ZERO, OWNER[1], '5000000')
    const f = (await resolveAndDedupSolana([a, b], { lookup: fakeLookup }))[0]
    const r = (await resolveAndDedupSolana([b, a], { lookup: fakeLookup }))[0]
    expect('deterministic: same survivor id both orders', f.id === r.id, `${f.id} vs ${r.id}`)
    expect('deterministic: survivor is the min (dash) id', f.id === a.id, `got ${f.id}`)
  }

  // 6. fail-loud — null DASH/ATA throws; null UNDERSCORE/owner is kept.
  {
    let threw = false
    try {
      await resolveAndDedupSolana([dash('hA', ZERO, NULL_DASH_ATA, '1')], { lookup: fakeLookup })
    } catch {
      threw = true
    }
    expect('fail-loud: null dash/ATA address throws', threw)

    const out = await resolveAndDedupSolana([under('hB', ZERO, NULL_OWNER, '1')], { lookup: fakeLookup })
    expect('fail-loud: null underscore/owner kept as-is', out.length === 1 && out[0].to === NULL_OWNER)
  }

  // 7. ladder — pairing → store → escalation → fail loud (each rung in isolation).
  {
    const CLOSED = NULL_DASH_ATA
    const OTHER_ATA = '3JghPkSoYGu4UvRQufrFw1GPj2A8pgMhFbcKXeHYc4Ay' // = ATA[1], live
    const OTHER_OWNER = OWNER[1]

    // 7a. in-window twin: the underscore record names the same leg under the owner
    //     representation, so the closed ATA resolves with no store and no network.
    {
      const saved: Array<{ ata: string; owner: string }> = []
      const store: AtaOwnerStore = {
        load: async () => new Map(),
        save: async (e) => { saved.push(...e) },
      }
      const out = await resolveAndDedupSolana(
        [dash('hC', OTHER_ATA, CLOSED, '7'), under('hC', OTHER_OWNER, OWNER[3], '7')],
        { lookup: fakeLookup, store }
      )
      expect('ladder/pairing: closed ATA recovered from its in-window twin',
        out.length === 1 && out[0].to === OWNER[3], `got ${out.length} rec(s), to=${out[0]?.to}`)
      expect('ladder/pairing: recovered mapping is persisted to the store',
        saved.length === 1 && saved[0].ata === CLOSED && saved[0].owner === OWNER[3],
        `got ${JSON.stringify(saved)}`)
    }

    // 7b. persisted store: no twin in this window, but an earlier run learned it.
    {
      let escalated = false
      const store: AtaOwnerStore = {
        load: async () => new Map([[CLOSED, OWNER[2]]]),
        save: async () => {},
      }
      const escalate: EscalationFetch = async () => { escalated = true; return [] }
      const out = await resolveAndDedupSolana(
        [dash('hD', OTHER_ATA, CLOSED, '3')], { lookup: fakeLookup, store, escalate }
      )
      expect('ladder/store: closed ATA recovered from the persisted map',
        out[0]?.to === OWNER[2], `got ${out[0]?.to}`)
      expect('ladder/store: a store hit short-circuits escalation', !escalated)
    }

    // 7c. escalation: neither the window nor the store knows it; records pulled from
    //     elsewhere in history carry the twin.
    {
      let asked: string[] = []
      const escalate: EscalationFetch = async (addrs) => {
        asked = addrs
        return [dash('hZ', OTHER_ATA, CLOSED, '9'), under('hZ', OTHER_OWNER, OWNER[0], '9')]
      }
      const out = await resolveAndDedupSolana(
        [dash('hE', OTHER_ATA, CLOSED, '4')], { lookup: fakeLookup, escalate }
      )
      expect('ladder/escalation: closed ATA recovered from cross-window records',
        out[0]?.to === OWNER[0], `got ${out[0]?.to}`)
      expect('ladder/escalation: asked for exactly the unresolved address',
        asked.length === 1 && asked[0] === CLOSED, `got ${JSON.stringify(asked)}`)
      expect('ladder/escalation: escalated records do NOT leak into the output',
        out.length === 1, `got ${out.length}`)
    }

    // 7d. every rung missed → fail loud, naming the address and a transaction.
    {
      let msg = ''
      try {
        await resolveAndDedupSolana([dash('hF', OTHER_ATA, CLOSED, '5')], {
          lookup: fakeLookup,
          store: { load: async () => new Map(), save: async () => {} },
          escalate: async () => [],
        })
      } catch (e) {
        msg = (e as Error).message
      }
      expect('ladder/fail-loud: throws when every rung misses', msg !== '')
      expect('ladder/fail-loud: names the unresolvable address', msg.includes(CLOSED))
      expect('ladder/fail-loud: names a sample transaction', msg.includes('sample tx hF'), msg.slice(0, 160))
    }

    // 7e. conflicting twins are never guessed at — the address stays unresolved.
    {
      const input = [
        dash('hG', OTHER_ATA, CLOSED, '1'), under('hG', OTHER_OWNER, OWNER[0], '1'),
        dash('hH', OTHER_ATA, CLOSED, '1'), under('hH', OTHER_OWNER, OWNER[2], '1'),
      ]
      let msg = ''
      try {
        await resolveAndDedupSolana(input, { lookup: fakeLookup })
      } catch (e) {
        msg = (e as Error).message
      }
      expect('ladder/conflict: disagreeing twins are not mapped (fails loud)', msg.includes(CLOSED))
      expect('ladder/conflict: the conflict is reported in the error', msg.includes('CONFLICTING'), msg.slice(0, 200))
      const { map, conflicts } = buildFeedPairingMap(input)
      expect('ladder/conflict: pairing reports it rather than picking one',
        !map.has(CLOSED) && conflicts.length === 1, `map=${map.has(CLOSED)} conflicts=${conflicts.length}`)
    }

    // 7f. (hash, value) fallback — the real shape where the trailing indices disagree
    //     (dash `2-<hash>-0` pairs with underscore `2_<hash>_3_-1`).
    {
      const out = await resolveAndDedupSolana(
        [mk('2-hI-0', 'hI', OTHER_ATA, CLOSED, '11'), mk('2_hI_3_-1', 'hI', OTHER_OWNER, OWNER[3], '11')],
        { lookup: fakeLookup }
      )
      expect('ladder/fallback: divergent tail indices still pair on (hash, value)',
        out.length === 1 && out[0].to === OWNER[3], `got ${out.length} rec(s), to=${out[0]?.to}`)
    }
  }

  // 8. REAL DATA — the captured window the backfill actually froze on.
  {
    const fixturePath = path.join(process.cwd(), 'scripts', 'fixtures', 'solana-usdy-2025-11-13.json')
    const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
      meta: { records: number; dashRecords: number; underscoreRecords: number; dashAddresses: number; liveAtas: number; closedAtas: number }
      addresses: string[]
      hashes: string[]
      // [hashIdx, idSuffix, fromIdx, toIdx, rawValue]; index -1 = the zero-address sentinel
      records: [number, string, number, number, string][]
      // addressIdx → owner addressIdx, or null when the account is absent from chain
      chain: Record<string, number | null>
      dashAddressIdx: number[]
    }
    const addr = (i: number) => (i < 0 ? ZERO : fx.addresses[i])
    const transfers: RwaTransfer[] = fx.records.map(([h, suffix, from, to, value]) =>
      // dash `2-<hash>-n` / underscore `2_<hash>_m_n` — the suffix carries its own separator
      mk(`2${suffix[0]}${fx.hashes[h]}${suffix}`, fx.hashes[h], addr(from), addr(to), value)
    )

    // On-chain truth, replayed offline: token account → owner, other account → itself,
    // absent account → null. Anything outside the capture resolves to itself.
    const chainLookup: AccountOwnerLookup = async (addresses) => {
      const m = new Map<string, string | null>()
      const idxOf = new Map(fx.addresses.map((a, i) => [a, i]))
      for (const a of addresses) {
        const i = idxOf.get(a)
        const owner = i === undefined ? undefined : fx.chain[String(i)]
        m.set(a, owner === undefined ? a : owner === null ? null : fx.addresses[owner])
      }
      return m
    }

    const dashAddrs = new Set(fx.dashAddressIdx.map((i) => fx.addresses[i]))
    const liveAtas = [...dashAddrs].filter((a) => {
      const owner = fx.chain[String(fx.addresses.indexOf(a))]
      return owner != null && fx.addresses[owner] !== a
    })
    const closedAtas = [...dashAddrs].filter((a) => fx.chain[String(fx.addresses.indexOf(a))] === null)

    expect('real: fixture is the captured window', transfers.length === fx.meta.records, `${transfers.length} vs ${fx.meta.records}`)
    expect(`real: ${fx.meta.dashAddresses} dash addresses, ${fx.meta.liveAtas} live / ${fx.meta.closedAtas} closed`,
      dashAddrs.size === fx.meta.dashAddresses && liveAtas.length === fx.meta.liveAtas && closedAtas.length === fx.meta.closedAtas,
      `${dashAddrs.size} / ${liveAtas.length} / ${closedAtas.length}`)

    // 8a. pairing agrees with chain wherever chain can still answer.
    const { map, conflicts } = buildFeedPairingMap(transfers)
    const agree = liveAtas.filter((a) => map.get(a) === fx.addresses[fx.chain[String(fx.addresses.indexOf(a))]!])
    const disagree = liveAtas.filter((a) => map.has(a) && map.get(a) !== fx.addresses[fx.chain[String(fx.addresses.indexOf(a))]!])
    expect(`real: pairing agrees with chain on all ${fx.meta.liveAtas} live ATAs`,
      agree.length === fx.meta.liveAtas && disagree.length === 0,
      `agree ${agree.length}, disagree ${disagree.length}`)
    expect('real: pairing produced no conflicting mappings', conflicts.length === 0, conflicts.join('; '))
    expect(`real: pairing covers all ${fx.meta.closedAtas} closed ATAs`,
      closedAtas.every((a) => map.has(a)), closedAtas.filter((a) => !map.has(a)).join(', '))

    // 8b. the window resolves end-to-end with NO store and NO escalation — the guard
    //     that froze the backfill must not fire on in-window pairing alone.
    const out = await resolveAndDedupSolana(transfers, { lookup: chainLookup })

    expect(`real: dedup collapses all ${fx.meta.dashRecords} dash records onto their twins`,
      out.length === fx.meta.underscoreRecords, `got ${out.length}, expected ${fx.meta.underscoreRecords}`)

    const survivors = new Set<string>()
    for (const t of out) {
      if (t.from && t.from !== ZERO) survivors.add(t.from)
      if (t.to && t.to !== ZERO) survivors.add(t.to)
    }
    const leakedDash = [...dashAddrs].filter((a) => survivors.has(a))
    expect(`real: none of the ${fx.meta.dashAddresses} dash addresses survives resolution`,
      leakedDash.length === 0, leakedDash.slice(0, 5).join(', '))

    // 8c. the chase — a pairing twin can itself be a live token account, and keying one
    //     would leave an ATA in the balance state.
    const leakedAtas = [...survivors].filter((a) => {
      const i = fx.addresses.indexOf(a)
      const owner = i < 0 ? undefined : fx.chain[String(i)]
      return owner != null && fx.addresses[owner] !== a
    })
    expect('real: no live token account survives as a balance key',
      leakedAtas.length === 0, leakedAtas.slice(0, 5).join(', '))
  }

  console.log('\n=== result ===')
  if (failures > 0) {
    console.error(`FAILED — ${failures} assertion(s) failed.`)
    process.exit(1)
  }
  console.log(
    'PARITY OK — ATA→owner resolution + twin dedup: rewrite, collapse, orphan→0, deterministic,\n' +
    '            ladder (pairing → store → escalation → fail-loud), and the real captured\n' +
    '            2025-11-13 USDY Solana window (3,129 records, 14 closed ATAs) resolving clean.'
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
