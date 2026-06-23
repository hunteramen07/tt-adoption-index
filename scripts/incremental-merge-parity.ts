/**
 * npm run test:incremental-parity
 *
 * Isolation parity gate for the incremental fetch-merge layer (src/lib/rwa/
 * incremental.ts). Runs entirely offline with in-memory fakes for the rwa.xyz
 * fetch and the Supabase reads/writes — no network, no DB, no writes, fully
 * deterministic. It proves:
 *
 *   1. numeric↔bigint storage conversion is lossless (flag A)
 *   2. boundary dedup drops exactly the already-seen rows (Subtlety 1)
 *   3. a single full backfill merge ≡ computeBalances(all)  (merge == replay)
 *   4. TWO incremental runs across a shared-timestamp boundary ≡ full backfill
 *      ≡ computeBalances(all)  (the headline: dedup neither double-counts nor skips)
 *   5. classification off merged state ≡ the proven full-history engine path
 *      (holderCount, mix, dormancy, exited, netNew, netAccumulationRatio)
 *   6. the firstReceipt re-entrant caveat (flag C): balances stay EXACT, but
 *      netNew/firstReceipt diverge for an exit-then-re-enter wallet — asserted
 *      explicitly so the known limitation is captured, not hidden.
 */

import { computeBalances } from '@/src/lib/etherscan/balances'
import { computeAggregateStats } from '@/src/lib/classify/engine'
import { toRawUnits } from '@/src/lib/rwa/transfers'
import type { RwaTransfer } from '@/src/lib/rwa/transfers'
import {
  parseNumericToBigInt,
  serializeBalance,
  dedupBoundary,
  isoToUnix,
  unixToIso,
  utcDay,
  mergeTransfers,
  runIncrementalFetchMerge,
  type BalanceStateMap,
  type FetchCursor,
  type IncrementalDeps,
} from '@/src/lib/rwa/incremental'

const ZERO = '0x0000000000000000000000000000000000000000'
// Anchor to a UTC midnight so day(n) lands on clean calendar-day boundaries and
// an intra-day hour offset (hr) stays within the same UTC day — required to model
// rwa.xyz's DAY-granular gte(date) and exercise the multi-tx-per-day boundary.
const BASE = Date.UTC(2024, 0, 1) / 1000 // 2024-01-01T00:00:00Z
const DAY = 86_400
const hr = 3_600
const day = (n: number) => BASE + n * DAY

let failures = 0
const ok = (m: string) => console.log(`  ✓ ${m}`)
const fail = (m: string) => {
  failures++
  console.error(`  ✗ ${m}`)
}
const expect = (label: string, cond: boolean, detail = '') =>
  cond ? ok(label) : fail(`${label}${detail ? ` — ${detail}` : ''}`)

function rtx(id: number | string, from: string, to: string, value: string, ts: number): RwaTransfer {
  return {
    id: String(id),
    from,
    to,
    value,
    timeStamp: String(ts),
    blockNumber: '0',
    hash: '0x' + id,
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

/**
 * Compare the POSITIVE-balance view of a merged state map against computeBalances
 * (which is positive-only). merged now retains balance-0 rows for firstReceipt
 * history, so those are excluded here — exactly as the orchestrator excludes them
 * from classification.
 */
function balancesEqual(a: BalanceStateMap, ref: Map<string, bigint>): boolean {
  const pos = new Map<string, bigint>()
  for (const [addr, s] of a) if (s.balance > BigInt(0)) pos.set(addr, s.balance)
  if (pos.size !== ref.size) return false
  for (const [addr, bal] of pos) {
    if (ref.get(addr) !== bal) return false
  }
  return true
}

/** In-memory fake DB + rwa fetch for one (product, network) key. */
interface FakeStore {
  cursor: FetchCursor | null
  state: BalanceStateMap
}

function makeFakeDeps(visibleStream: RwaTransfer[], store: FakeStore): IncrementalDeps {
  // Models rwa.xyz's DAY-granular gte(date): a row is returned iff its UTC
  // calendar day is >= the sinceDate's day (NOT its exact timestamp). This is the
  // fidelity that the earlier timestamp-granular fake lacked — without it the
  // whole-day re-fetch overlap (and thus the day-boundary dedup) is never tested.
  const since = (sinceDate: string | null) =>
    sinceDate === null
      ? visibleStream
      : visibleStream.filter((t) => utcDay(parseInt(t.timeStamp)) >= utcDay(isoToUnix(sinceDate)))
  return {
    loadCursor: async () => store.cursor,
    loadState: async () => {
      const clone: BalanceStateMap = new Map()
      for (const [a, s] of store.state) clone.set(a, { balance: s.balance, firstReceipt: s.firstReceipt })
      return clone
    },
    fetchAllTimeSince: async (sinceDate) => since(sinceDate),
    fetchWindow: async (sinceDate) => since(sinceDate),
    // Simulates cursor-last persistence: merged map (already minus exited rows)
    // becomes the new state; cursor advances only when newCursor is set.
    writeBack: async (p) => {
      store.state = p.merged
      if (p.newCursor) store.cursor = p.newCursor
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) numeric ↔ bigint losslessness
// ─────────────────────────────────────────────────────────────────────────────
function testNumericConversion() {
  console.log('\n[1] numeric ↔ bigint losslessness')
  const huge = '449946534147315186905' // > 2^53; would lose precision as a JS number
  expect('parse huge integer string', parseNumericToBigInt(huge) === BigInt(huge), huge)
  expect('round-trips through serializeBalance', serializeBalance(parseNumericToBigInt(huge)) === huge)
  expect('Number() would have lost precision', String(Number(huge)) !== huge) // sanity: proves the hazard is real
  expect('accepts all-zero fraction "100.000"', parseNumericToBigInt('100.000') === BigInt(100))
  let threw = false
  try {
    parseNumericToBigInt('100.5')
  } catch {
    threw = true
  }
  expect('rejects non-integer fraction "100.5" (catches float coercion)', threw)
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) boundary dedup — explicit
// ─────────────────────────────────────────────────────────────────────────────
function testDedup() {
  console.log('\n[2] boundary dedup (drop ids in the boundary set; id ORDER irrelevant)')
  // Composite, non-time-ordered ids — the real rwa.xyz shape. Three rows share
  // the boundary second day(10); the cursor recorded {idA, idB} as already-seen.
  // A re-fetch must drop exactly those two by id equality and keep the genuinely
  // new same-second idC plus the later-second idD — regardless of any
  // lexical/numeric order of the id strings (idA is lexically large, idB small).
  const idA = '1-0xff0000-2'
  const idB = '1-0x0a00aa-9'
  const idC = '1-0x7c12de-1'
  const idD = '1-0x3e9bef-4'
  const refetched = [
    rtx(idA, ZERO, '0xa', '1', day(10)),
    rtx(idB, ZERO, '0xb', '1', day(10)),
    rtx(idC, ZERO, '0xc', '1', day(10)), // NEW at the boundary second ⇒ must survive
    rtx(idD, ZERO, '0xd', '1', day(11)),
  ]
  const kept = dedupBoundary(refetched, [idA, idB])
  expect('kept ids are exactly [idC, idD]', JSON.stringify(kept.map((t) => t.id)) === JSON.stringify([idC, idD]))
  expect('full backfill (boundaryIds=null) drops nothing', dedupBoundary(refetched, null).length === 4)
  expect('empty boundary set drops nothing', dedupBoundary(refetched, []).length === 4)
  // Drop is by equality, not order: a boundary id that sorts BELOW a kept id is
  // still dropped, and a kept id that sorts BELOW a dropped id still survives.
  expect('drops the lexically-large boundary id idA', !kept.some((t) => t.id === idA))
  expect('keeps the lexically-small new id idC', kept.some((t) => t.id === idC))
}

// The headline clean stream (no exits): prefix = ids 1..11, "new" = ids 12..14.
// ids 10,11,12 deliberately share CALENDAR DAY day(10) but sit at different HOURS,
// so the day-granular re-fetch returns all three. run#1 processes only 10 & 11;
// id 12 is a new same-day row that must survive dedup. This is what distinguishes
// a correct day-boundary set from a too-narrow last-second set: a last-second
// cursor would record only id 11 and then re-merge the earlier same-day id 10.
function cleanStream(): { prefix: RwaTransfer[]; full: RwaTransfer[] } {
  const A = '0x' + 'a'.repeat(40)
  const B = '0x' + 'b'.repeat(40)
  const C = '0x' + 'c'.repeat(40)
  const D = '0x' + 'd'.repeat(40)
  const E = '0x' + 'e'.repeat(40)
  const full = [
    rtx(1, ZERO, A, '100', day(1)), // mint A
    rtx(2, ZERO, B, '100', day(2)), // mint B
    rtx(3, A, B, '40', day(3)),
    rtx(4, ZERO, C, '50', day(4)), // mint C
    rtx(5, B, C, '20', day(5)),
    rtx(6, ZERO, D, '80', day(6)), // mint D
    rtx(7, C, A, '10', day(7)),
    rtx(8, D, B, '30', day(8)),
    rtx(9, ZERO, E, '25', day(9)), // mint E
    rtx(10, A, B, '5', day(10) + 1 * hr), // ┐ all three on calendar day(10),
    rtx(11, C, D, '5', day(10) + 5 * hr), // ┘ different hours; run#1 stops after 11
    rtx(12, E, B, '5', day(10) + 9 * hr), //   NEW same-day row ⇒ must survive dedup
    rtx(13, ZERO, A, '10', day(11) + 2 * hr),
    rtx(14, B, E, '15', day(11) + 6 * hr),
  ]
  return { prefix: full.slice(0, 11), full }
}

// ─────────────────────────────────────────────────────────────────────────────
// (3) full backfill merge ≡ computeBalances(all)
// ─────────────────────────────────────────────────────────────────────────────
async function testFullBackfill() {
  console.log('\n[3] full backfill merge ≡ computeBalances(all)')
  const { full } = cleanStream()
  const store: FakeStore = { cursor: null, state: new Map() }
  const deps = makeFakeDeps(full, store)
  const res = await runIncrementalFetchMerge(
    { productSlug: 'p', network: 'ethereum', mode: 'aggregate', nowTs: day(15), windowSeconds: 8 * DAY },
    deps
  )
  expect('merged ≡ computeBalances(full)', balancesEqual(res.merged, computeBalances(full)))
  expect('cursor timestamp = latest tx on day(11)', res.newCursor?.lastTxTimestamp === unixToIso(day(11) + 6 * hr))
  expect('boundary ids = ALL day(11) rows [13,14]',
    JSON.stringify([...(res.newCursor?.boundaryIds ?? [])].sort()) === JSON.stringify(['13', '14']))
  expect('no boundary rows dropped on full backfill', res.dedupedBoundaryCount === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// (4) two incremental runs across the boundary ≡ full backfill
// ─────────────────────────────────────────────────────────────────────────────
async function testIncrementalAcrossBoundary() {
  console.log('\n[4] incremental (2 runs across shared-timestamp boundary) ≡ full replay')
  const { prefix, full } = cleanStream()
  const store: FakeStore = { cursor: null, state: new Map() }

  // Run #1: only the prefix is visible (full backfill of what existed then).
  const r1 = await runIncrementalFetchMerge(
    { productSlug: 'p', network: 'ethereum', mode: 'aggregate', nowTs: day(15), windowSeconds: 8 * DAY },
    makeFakeDeps(prefix, store)
  )
  expect('run#1 cursor ts = latest day(10) tx (id 11 @ +5h)', r1.newCursor?.lastTxTimestamp === unixToIso(day(10) + 5 * hr))
  expect('run#1 boundary ids = ALL processed day(10) rows [10,11]',
    JSON.stringify([...(r1.newCursor?.boundaryIds ?? [])].sort()) === JSON.stringify(['10', '11']))

  // Run #2: full stream now visible; resumes from the cursor (gte day(10), which
  // the day-granular fetch expands to the WHOLE of day(10) ⇒ ids 10,11,12).
  const r2 = await runIncrementalFetchMerge(
    { productSlug: 'p', network: 'ethereum', mode: 'aggregate', nowTs: day(15), windowSeconds: 8 * DAY },
    makeFakeDeps(full, store)
  )
  expect('run#2 re-fetched all of day(10)+day(11) (gte day-granular)', r2.fetchedCount === 5) // 10,11,12,13,14
  expect('run#2 dropped ids 10 & 11 as already-seen (whole-day boundary)', r2.dedupedBoundaryCount === 2)
  expect('run#2 kept id 12 (new, same day, later hour)', r2.newCount === 3) // 12,13,14
  expect('merged ≡ computeBalances(full) (no double-count, no skip)', balancesEqual(r2.merged, computeBalances(full)))
  expect('cursor ts advanced to latest day(11) tx', r2.newCursor?.lastTxTimestamp === unixToIso(day(11) + 6 * hr))
  expect('cursor boundary ids = ALL day(11) rows [13,14]',
    JSON.stringify([...(r2.newCursor?.boundaryIds ?? [])].sort()) === JSON.stringify(['13', '14']))
}

// ─────────────────────────────────────────────────────────────────────────────
// (4b) carry-forward: successive runs whose new rows land on the SAME boundary DAY.
//
// Exercises the union branch of computeNewCursor — when the max calendar DAY does
// NOT advance, last run's boundary ids (deduped out of this run's new set) must
// be carried forward so a THIRD run still recognises them as already-seen. Get
// this wrong and the third run re-merges the whole day → double-count.
// ─────────────────────────────────────────────────────────────────────────────
async function testSameDayCarryForward() {
  console.log('\n[4b] same-day carry-forward: boundary id set unions across runs')
  const A = '0x' + 'a'.repeat(40)
  const B = '0x' + 'b'.repeat(40)
  const C = '0x' + 'c'.repeat(40)
  const D = '0x' + 'd'.repeat(40)
  // ids 2,3,4 all fall on calendar day(5) (different hours); each run reveals one
  // more of them, so the max DAY never advances.
  const t1 = rtx(1, ZERO, A, '100', day(1))
  const t2 = rtx(2, ZERO, B, '50', day(5) + 1 * hr)
  const t3 = rtx(3, ZERO, C, '60', day(5) + 5 * hr)
  const t4 = rtx(4, ZERO, D, '70', day(5) + 9 * hr)
  const opts = { productSlug: 'p', network: 'ethereum', mode: 'aggregate' as const, nowTs: day(15), windowSeconds: 20 * DAY }
  const store: FakeStore = { cursor: null, state: new Map() }

  // Run#1 sees {1,2,3}; boundary day(5) ⇒ {2,3}.
  const r1 = await runIncrementalFetchMerge(opts, makeFakeDeps([t1, t2, t3], store))
  expect('run#1 boundary ids = [2,3]',
    JSON.stringify([...(r1.newCursor?.boundaryIds ?? [])].sort()) === JSON.stringify(['2', '3']))

  // Run#2 reveals id 4 later the SAME day. gte(day5) re-fetches all of day(5)
  // {2,3,4}; dedup drops 2,3; only 4 is new. Day unchanged ⇒ boundary unions to {2,3,4}.
  const r2 = await runIncrementalFetchMerge(opts, makeFakeDeps([t1, t2, t3, t4], store))
  expect('run#2 dropped the carried boundary {2,3}', r2.dedupedBoundaryCount === 2)
  expect('run#2 merged only id 4', r2.newCount === 1)
  expect('run#2 boundary ids unioned to [2,3,4]',
    JSON.stringify([...(r2.newCursor?.boundaryIds ?? [])].sort()) === JSON.stringify(['2', '3', '4']))
  expect('merged ≡ computeBalances(full)', balancesEqual(r2.merged, computeBalances([t1, t2, t3, t4])))

  // Run#3 with no new data must drop ALL re-fetched same-day rows and merge nothing.
  const r3 = await runIncrementalFetchMerge(opts, makeFakeDeps([t1, t2, t3, t4], store))
  expect('run#3 merged nothing (whole day recognised)', r3.newCount === 0)
  expect('run#3 balances unchanged ≡ computeBalances(full)', balancesEqual(r3.merged, computeBalances([t1, t2, t3, t4])))
}

// ─────────────────────────────────────────────────────────────────────────────
// (5) classification off merged state ≡ full-history engine path
// ─────────────────────────────────────────────────────────────────────────────
async function testClassificationParity() {
  console.log('\n[5] classification parity: incremental merged-state ≡ computeAggregateStats(full)')
  const { prefix, full } = cleanStream()
  const store: FakeStore = { cursor: null, state: new Map() }
  // Default 90d window (windowSeconds omitted) so the engine's internal window
  // and the fetched window match the full-history oracle exactly.
  const opts = { productSlug: 'p', network: 'ethereum', mode: 'aggregate' as const, nowTs: day(15) }
  await runIncrementalFetchMerge(opts, makeFakeDeps(prefix, store))
  const r2 = await runIncrementalFetchMerge(opts, makeFakeDeps(full, store))

  const inc = r2.aggregateStats!
  const oracle = computeAggregateStats(full, opts.nowTs)

  expect('holderCount', inc.holderCount === oracle.holderCount, `${inc.holderCount} vs ${oracle.holderCount}`)
  expect('mix.accumulating', inc.mix.accumulating === oracle.mix.accumulating)
  expect('mix.distributing', inc.mix.distributing === oracle.mix.distributing)
  expect('mix.dormant', inc.mix.dormant === oracle.mix.dormant)
  expect('mix.active', inc.mix.active === oracle.mix.active)
  expect('dormancySharePct', inc.dormancySharePct === oracle.dormancySharePct)
  expect('netNewWallets90d', inc.netNewWallets90d === oracle.netNewWallets90d, `${inc.netNewWallets90d} vs ${oracle.netNewWallets90d}`)
  expect('exitedWallets90d', inc.exitedWallets90d === oracle.exitedWallets90d, `${inc.exitedWallets90d} vs ${oracle.exitedWallets90d}`)
  expect('netAccumulationRatio', inc.netAccumulationRatio === oracle.netAccumulationRatio)
}

// ─────────────────────────────────────────────────────────────────────────────
// (6) re-entrant + stay-exited: with retained zero rows, parity is now EXACT.
//
// This test previously asserted firstReceipt/netNew DRIFT. With exited wallets
// kept as balance-0 rows (firstReceipt preserved), the drift is gone — so it now
// asserts EXACT equality. That flip is the proof the fix worked.
//
// Timestamps span > 90 days so the discriminator bites: X's true first receipt
// (day 1) is OUTSIDE the trailing-90d window while its re-entry (day 200) is
// INSIDE. The OLD delete-on-exit behavior would have lost day-1 and miscounted X
// as net-new; with preservation, X is correctly excluded and only the genuinely
// new wallet W (day 150) counts.
// ─────────────────────────────────────────────────────────────────────────────
async function testReentrantExact() {
  console.log('\n[6] re-entrant + stay-exited: retained zero rows ⇒ netNew/firstReceipt now EXACT')
  const X = '0x' + '1'.repeat(40)
  const Y = '0x' + '2'.repeat(40)
  const Z = '0x' + '3'.repeat(40)
  const W = '0x' + '4'.repeat(40)
  const full = [
    rtx(1, ZERO, X, '100', day(1)), // X first receipt = day(1) — OUTSIDE the 90d window
    rtx(2, ZERO, Y, '50', day(2)),
    rtx(3, X, Y, '100', day(5)), // X exits → balance 0 (row RETAINED, not deleted)
    rtx(4, ZERO, Z, '60', day(10)), // Z first receipt = day(10)
    rtx(5, Z, Y, '60', day(20)), // Z exits and STAYS out → balance-0 row retained
    rtx(6, ZERO, W, '30', day(150)), // W mint INSIDE window — genuine net-new
    rtx(7, ZERO, X, '40', day(200)), // X RE-ENTERS inside window
  ]
  const prefix = full.slice(0, 5) // run#1 ends with X and Z both exited
  const store: FakeStore = { cursor: null, state: new Map() }
  const opts = { productSlug: 'p', network: 'ethereum', mode: 'aggregate' as const, nowTs: day(205) }

  const r1 = await runIncrementalFetchMerge(opts, makeFakeDeps(prefix, store))
  // Run#1 must have RETAINED the exited rows (no deletion).
  expect('run#1 retains exited X as balance-0 row', r1.merged.get(X)?.balance === BigInt(0))
  expect('run#1 retains exited Z as balance-0 row', r1.merged.get(Z)?.balance === BigInt(0))
  expect('run#1 preserves X.firstReceipt = day(1)', r1.merged.get(X)?.firstReceipt === day(1))

  const r2 = await runIncrementalFetchMerge(opts, makeFakeDeps(full, store))

  // Balances exact (positive view) and the stay-exited Z still present at 0.
  expect('positive balances ≡ computeBalances(full)', balancesEqual(r2.merged, computeBalances(full)))
  expect('stay-exited Z retained at balance 0 with firstReceipt day(10)',
    r2.merged.get(Z)?.balance === BigInt(0) && r2.merged.get(Z)?.firstReceipt === day(10))
  // THE FLIP: X's original first receipt survived the exit→re-entry.
  expect('X.firstReceipt preserved as day(1) (was day(200) under old delete behavior)',
    r2.merged.get(X)?.firstReceipt === day(1))

  // Full equality against the full-history oracle — now including netNew.
  const inc = r2.aggregateStats!
  const oracle = computeAggregateStats(full, opts.nowTs)
  expect('holderCount', inc.holderCount === oracle.holderCount, `${inc.holderCount} vs ${oracle.holderCount}`)
  expect('mix.accumulating', inc.mix.accumulating === oracle.mix.accumulating)
  expect('mix.distributing', inc.mix.distributing === oracle.mix.distributing)
  expect('mix.dormant', inc.mix.dormant === oracle.mix.dormant)
  expect('mix.active', inc.mix.active === oracle.mix.active)
  expect('dormancySharePct', inc.dormancySharePct === oracle.dormancySharePct)
  expect('netNewWallets90d EXACT (X excluded, only W counts)',
    inc.netNewWallets90d === oracle.netNewWallets90d, `${inc.netNewWallets90d} vs ${oracle.netNewWallets90d}`)
  expect('exitedWallets90d', inc.exitedWallets90d === oracle.exitedWallets90d, `${inc.exitedWallets90d} vs ${oracle.exitedWallets90d}`)
  expect('netAccumulationRatio', inc.netAccumulationRatio === oracle.netAccumulationRatio)
  console.log(`    → netNew = ${inc.netNewWallets90d} (W only); re-entrant X correctly NOT net-new. Divergence eliminated.`)
}

// ─────────────────────────────────────────────────────────────────────────────
// (7) case-sensitive (base58) addresses are preserved, never lowercased.
//
// Solana/XRPL/Stellar addresses are case-sensitive: lowercasing them collides
// distinct wallets (the live BUIDL Solana corruption). With caseSensitive=true the
// merge must key holders VERBATIM; the default (EVM) path must still lowercase —
// so the same input collapses there, proving the default behavior is unchanged.
// Also asserts the zero-address sentinel still resolves under caseSensitive=true.
// ─────────────────────────────────────────────────────────────────────────────
function testCaseSensitiveAddresses() {
  console.log('\n[7] case-sensitive (base58) addresses: preserved verbatim, never lowercased')
  // A real Solana-style base58 address and its lowercase form = two DISTINCT wallets.
  const W = 'GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr'
  const Wlower = W.toLowerCase()
  const txs = [
    rtx('1-h-1', ZERO, W, '100', day(1)), // mint 100 → W
    rtx('1-h-2', ZERO, Wlower, '40', day(2)), // mint 40 → lowercase twin
    rtx('1-h-3', W, ZERO, '30', day(3)), // burn 30 from W
  ]

  // caseSensitive=true: verbatim keys, twins stay distinct.
  const { merged } = mergeTransfers(new Map(), txs, true)
  expect('W and its lowercase twin are DISTINCT keys', merged.has(W) && merged.has(Wlower) && W !== Wlower)
  expect('W balance = 70 (100 in − 30 burn), case preserved', merged.get(W)?.balance === BigInt(70))
  expect('lowercase twin balance = 40 (not merged into W)', merged.get(Wlower)?.balance === BigInt(40))
  expect('stored key is verbatim mixed-case', [...merged.keys()].includes(W))
  expect('zero-address sentinel still resolved (no 0x0 holder row)', !merged.has(ZERO))

  // Default (EVM) path lowercases — the SAME input collapses to one key, proving
  // existing call sites are byte-identical and the bug is what we just prevented.
  const { merged: evm } = mergeTransfers(new Map(), txs)
  expect('EVM default collapses both into the lowercase key (unchanged behavior)',
    evm.size === 1 && evm.get(Wlower)?.balance === BigInt(110)) // 100 + 40 − 30
}

// ─────────────────────────────────────────────────────────────────────────────
// (8) per-token decimals: amount→raw uses the TOKEN's decimals, not a fund-level
// constant. A 6-decimal token (OUSG Solana/XRPL) must convert distinctly from an
// 18-decimal one; using the wrong (18) value over-scales a 6-dp amount by 10^12.
// ─────────────────────────────────────────────────────────────────────────────
function testDecimalsConversion() {
  console.log('\n[8] per-token decimals: amount→raw scales by the token decimals')
  expect('6-dp integer 1 → 1e6 raw', toRawUnits(1, 6) === '1000000')
  expect('6-dp fraction 1.5 → 1500000 raw', toRawUnits(1.5, 6) === '1500000')
  expect('18-dp integer 1 → 1e18 raw', toRawUnits(1, 18) === '1000000000000000000')
  // Same amount under the WRONG (18) decimals is exactly 10^12× the correct 6-dp
  // value — the silent mis-scale per-token decimals + the fetch guard prevent.
  expect('wrong 18-dp scaling = 10^12× the 6-dp value (distinct)',
    BigInt(toRawUnits(1, 18)) === BigInt(toRawUnits(1, 6)) * (BigInt(10) ** BigInt(12)))
}

async function main() {
  console.log('=== incremental fetch-merge parity gate (offline, deterministic) ===')
  testNumericConversion()
  testDedup()
  await testFullBackfill()
  await testIncrementalAcrossBoundary()
  await testSameDayCarryForward()
  await testClassificationParity()
  await testReentrantExact()
  testCaseSensitiveAddresses()
  testDecimalsConversion()

  console.log('\n=== result ===')
  if (failures > 0) {
    console.error(`PARITY FAILED: ${failures} assertion(s)`)
    process.exit(1)
  }
  console.log('PARITY OK — incremental merge ≡ full replay; dedup + conversion proven; caveat captured.')
}

main().catch((err) => {
  console.error('\n[incremental-parity] fatal error:', err)
  process.exit(1)
})
