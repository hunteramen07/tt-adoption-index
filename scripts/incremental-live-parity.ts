/**
 * npm run test:incremental-live-parity
 *
 * LIVE USDY parity gate for the incremental fetch-merge layer. Proves that one
 * incremental run (simulated as two runs across a real cursor boundary) on real
 * USDY data reproduces the full-history oracle on every aggregate metric.
 *
 * DATA SOURCE — CACHED FIXTURE (flagged): transfer data comes from the cached
 * 13,064-transfer USDY history (.cache/etherscan/transfers-0x96f6…985c.json), not
 * a fresh rwa.xyz pull. This keeps the test deterministic and free of RWA_API_KEY,
 * yet still drives the data through the FULL incremental code path. Each row gets
 * a COMPOSITE id of the real rwa.xyz shape — `1-{txHash}-{i}` — which, like the
 * live API, is non-numeric and NOT time-ordered (hash, not sequence). The cursor
 * therefore resumes by TIMESTAMP and dedups the boundary by id-set membership;
 * the assertions below confirm that holds against ids that do not track time.
 *
 * WHAT IS LIVE: the Supabase writes ARE real. Run A and Run B persist to
 * holder_balance_state / fetch_cursor via the apply_incremental_merge RPC, and
 * the final result is read BACK from the numeric column — so this end-to-end
 * exercises RPC atomicity and the lossless numeric↔bigint boundary on real
 * 18-decimal balances. Rows are written under a test-scoped product_slug
 * ('usdy-paritytest') and deleted in a finally block, leaving no residue.
 *
 * Requires Supabase env (NEXT_PUBLIC_SUPABASE_URL + a service/anon key) and the
 * fetch_cursor / holder_balance_state tables + apply_incremental_merge function
 * deployed to the target project.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { readFileSync } from 'fs'
import { join } from 'path'
import type { ERC20Transfer } from '@/src/lib/etherscan/types'
import {
  computeAggregateStats,
  computeAggregateStatsFromState,
  WINDOW_SECONDS,
} from '@/src/lib/classify/engine'
import type { RwaTransfer } from '@/src/lib/rwa/transfers'
import {
  makeSupabaseDeps,
  isoToUnix,
  unixToIso,
  utcDay,
  type BalanceStateMap,
  type IncrementalDeps,
} from '@/src/lib/rwa/incremental'
import { getSupabase } from '@/src/lib/supabase/client'

const TEST_SLUG = 'usdy-paritytest'
const NETWORK = 'ethereum'
const USDY_FIXTURE =
  '.cache/etherscan/transfers-0x96f6ef951840721adbf46ac996b59e0235cb985c.json'

let failures = 0
const ok = (m: string) => console.log(`  ✓ ${m}`)
const fail = (m: string) => {
  failures++
  console.error(`  ✗ ${m}`)
}
const expectEq = (label: string, a: unknown, b: unknown) =>
  a === b ? ok(`${label}: ${String(a)}`) : fail(`${label}: incremental=${String(a)} oracle=${String(b)}`)

/**
 * Load the cached USDY history, sort by timestamp for a deterministic master
 * order, and assign each row a COMPOSITE rwa.xyz-shaped id `1-{txHash}-{i}`.
 * The id is intentionally hash-based (NOT sequential), so it does not track time
 * — the live property that broke the old numeric-id cursor. `i` disambiguates
 * multiple transfers sharing a hash.
 */
function loadUsdyMaster(): RwaTransfer[] {
  const parsed = JSON.parse(readFileSync(join(process.cwd(), USDY_FIXTURE), 'utf8'))
  const fixture: ERC20Transfer[] = parsed.data ?? parsed
  return fixture
    .map((t, i) => ({ t, i }))
    .sort((a, b) => parseInt(a.t.timeStamp) - parseInt(b.t.timeStamp) || a.i - b.i)
    .map(({ t, i }): RwaTransfer => ({ ...t, id: `1-${t.hash}-${i}` }))
}

/**
 * Real Supabase load/write deps (incl. the RPC write-back), with fetch overridden
 * to serve from the in-memory fixture. `visibleUniverse` is what "exists" at the
 * time of the run; the window pull always sees the full master (it is now-relative
 * and cursor-independent, matching the oracle's internal window).
 */
function hybridDeps(
  base: IncrementalDeps,
  master: RwaTransfer[],
  visibleUniverse: RwaTransfer[]
): IncrementalDeps {
  // DAY-granular gte(date), matching the live rwa.xyz filter: a row is included
  // iff its UTC calendar day >= the sinceDate's day (not its exact timestamp).
  const sliceSince = (stream: RwaTransfer[], sinceDate: string | null) =>
    sinceDate === null ? stream : stream.filter((t) => utcDay(parseInt(t.timeStamp)) >= utcDay(isoToUnix(sinceDate)))
  return {
    loadCursor: base.loadCursor,
    loadState: base.loadState,
    writeBack: base.writeBack,
    fetchAllTimeSince: async (sinceDate) => sliceSince(visibleUniverse, sinceDate),
    fetchWindow: async (sinceDate) => sliceSince(master, sinceDate),
  }
}

async function cleanup() {
  const supabase = getSupabase()
  await supabase.from('holder_balance_state').delete().eq('product_slug', TEST_SLUG)
  await supabase.from('fetch_cursor').delete().eq('product_slug', TEST_SLUG)
}

async function main() {
  console.log('=== LIVE USDY incremental parity gate ===')
  console.log('data: cached fixture (deterministic) | writes: REAL Supabase RPC round-trip\n')

  const master = loadUsdyMaster()
  const timestamps = master.map((t) => parseInt(t.timeStamp))
  const nowTs = Math.max(...timestamps) // window = last 90d of real data
  const splitTs = timestamps[Math.floor(timestamps.length / 2)] // median split
  const visibleA = master.filter((t) => parseInt(t.timeStamp) <= splitTs)

  console.log(
    `USDY: ${master.length} transfers, ${new Date(Math.min(...timestamps) * 1000)
      .toISOString()
      .slice(0, 10)} → ${new Date(nowTs * 1000).toISOString().slice(0, 10)}`
  )
  console.log(
    `split @ ${new Date(splitTs * 1000).toISOString().slice(0, 10)} — Run A sees ${visibleA.length}, Run B sees all ${master.length}\n`
  )

  // ── Oracle: the proven full-history path on all transfers. ──────────────────
  const oracle = computeAggregateStats(master, nowTs)

  // dummy config: only the fetch closures use it, and we override those.
  const base = await makeSupabaseDeps({ assetId: 0, networkId: 0, decimals: 18, tokenAddresses: [] })
  const params = { productSlug: TEST_SLUG, network: NETWORK, mode: 'aggregate' as const, nowTs }

  try {
    await cleanup() // start clean in case a prior run left residue

    const { runIncrementalFetchMerge } = await import('@/src/lib/rwa/incremental')

    // ── Run A — backfill (null cursor), persists via RPC. ─────────────────────
    console.log('[Run A] backfill up to split…')
    const rA = await runIncrementalFetchMerge(params, hybridDeps(base, master, visibleA))
    console.log(`  fetched ${rA.fetchedCount}, merged ${rA.merged.size} rows, cursor → ${rA.newCursor?.lastTxTimestamp} (+${rA.newCursor?.boundaryIds.length ?? 0} boundary id(s))`)
    expectEq('Run A processed the pre-split slice', rA.newCount, visibleA.length)

    // ── Run B — incremental (reads Run A cursor), gte + dedup, persists. ───────
    console.log('[Run B] incremental from cursor…')
    const rB = await runIncrementalFetchMerge(params, hybridDeps(base, master, master))
    console.log(
      `  fetched ${rB.fetchedCount}, dedup-dropped ${rB.dedupedBoundaryCount} boundary rows, merged ${rB.newCount} new, cursor → ${rB.newCursor?.lastTxTimestamp} (+${rB.newCursor?.boundaryIds.length ?? 0} boundary id(s))`
    )
    expectEq('Run B cursor reached the final timestamp', rB.newCursor?.lastTxTimestamp, unixToIso(nowTs))
    if (rB.dedupedBoundaryCount >= 1) ok(`Run B exercised the boundary (dropped ${rB.dedupedBoundaryCount} re-fetched row(s))`)
    else fail('Run B dropped no boundary rows — split did not exercise the gte overlap')
    if (rB.newCount > 0) ok(`Run B merged ${rB.newCount} genuinely-new transfers across the gap`)
    else fail('Run B merged nothing new — split is degenerate')

    // ── Final read-back FROM THE DB, then compute aggregate stats. ────────────
    console.log('[final] reading persisted state back through the numeric column…')
    const finalState = await base.loadState(TEST_SLUG, NETWORK)
    const positive: BalanceStateMap = new Map()
    for (const [addr, s] of finalState) if (s.balance > BigInt(0)) positive.set(addr, s)
    const windowTransfers = master.filter((t) => parseInt(t.timeStamp) >= nowTs - WINDOW_SECONDS)
    const incremental = computeAggregateStatsFromState(positive, windowTransfers, nowTs)

    console.log(`  persisted rows: ${finalState.size} (positive holders: ${positive.size})\n`)

    // ── Assert: incremental (A+B, via DB) ≡ full-replay oracle, every metric. ─
    console.log('--- incremental (A+B, read from DB) vs full-replay oracle ---')
    expectEq('holderCount', incremental.holderCount, oracle.holderCount)
    expectEq('mix.accumulating', incremental.mix.accumulating, oracle.mix.accumulating)
    expectEq('mix.distributing', incremental.mix.distributing, oracle.mix.distributing)
    expectEq('mix.dormant', incremental.mix.dormant, oracle.mix.dormant)
    expectEq('mix.active', incremental.mix.active, oracle.mix.active)
    expectEq('mix.total', incremental.mix.total, oracle.mix.total)
    expectEq('dormancySharePct', incremental.dormancySharePct, oracle.dormancySharePct)
    expectEq('netNewWallets90d', incremental.netNewWallets90d, oracle.netNewWallets90d)
    expectEq('exitedWallets90d', incremental.exitedWallets90d, oracle.exitedWallets90d)
    expectEq('netAccumulationRatio', incremental.netAccumulationRatio, oracle.netAccumulationRatio)
  } finally {
    console.log('\n[cleanup] deleting usdy-paritytest rows…')
    await cleanup()
    ok('test rows removed')
  }

  console.log('\n=== result ===')
  if (failures > 0) {
    console.error(`LIVE PARITY FAILED: ${failures} mismatch(es)`)
    process.exit(1)
  }
  console.log('LIVE PARITY OK — A+B incremental ≡ full replay on real USDY, through the real DB/RPC path.')
}

main().catch((err) => {
  console.error('\n[incremental-live-parity] fatal error:', err)
  process.exit(1)
})
