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
 */

import { resolveAndDedupSolana, type AccountOwnerLookup } from '@/src/lib/rwa/solana-resolve'
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

  console.log('\n=== result ===')
  if (failures > 0) {
    console.error(`FAILED — ${failures} assertion(s) failed.`)
    process.exit(1)
  }
  console.log('PARITY OK — ATA→owner resolution + twin dedup: rewrite, collapse, orphan→0, deterministic, fail-loud.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
