/**
 * npm run test:engine-parity
 *
 * Refactor parity gate for src/lib/classify/engine.ts.
 *
 * The engine was refactored into reusable cores (classifyHoldersFromState,
 * computeAggregateStatsFromState) with classifyHolders / computeAggregateStats
 * kept as thin transfers-in wrappers. This gate proves the wrappers produce
 * byte-identical output to the PRE-CHANGE implementation, which is embedded
 * below verbatim as a reference oracle (legacy*).
 *
 * It feeds both the oracle and the new wrappers identical inputs and asserts
 * deep equality on every metric — holder count, full behavior mix, dormancy
 * share, netAccumulationRatio, and specifically netNewWallets90d /
 * exitedWallets90d. Inputs: the real cached USDY transfer history across
 * several nowTs values (so the 90-day window straddles real exits / net-new),
 * plus synthetic fixtures that stress the exitedWallets90d reconstruction.
 *
 * Read-only, offline, deterministic: no network, no Supabase, no writes.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { ERC20Transfer } from '@/src/lib/etherscan/types'
import { computeBalances } from '@/src/lib/etherscan/balances'
import {
  computeBehavioralMix,
  computeDormancySharePct,
  classifyHolders,
  computeAggregateStats,
} from '@/src/lib/classify/engine'
import type { BehaviorLabel, HolderClassification } from '@/src/lib/classify/types'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const WINDOW_SECONDS = 90 * 24 * 3600

// ──────────────────────────────────────────────────────────────────────────
// Reference oracle: the engine BEFORE the FromState refactor, copied verbatim.
// computeBehavioralMix / computeDormancySharePct were not changed, so they are
// imported rather than duplicated. legacyComputeAggregateStats deliberately
// calls legacyClassifyHolders so the oracle is fully self-contained.
// ──────────────────────────────────────────────────────────────────────────

function legacyClassifyHolders(
  transfers: ERC20Transfer[],
  nowTs: number
): Map<string, HolderClassification> {
  const windowStart = nowTs - WINDOW_SECONDS
  const balances = computeBalances(transfers)

  type Flows = { inflow: bigint; outflow: bigint }
  const flows = new Map<string, Flows>()

  for (const t of transfers) {
    if (parseInt(t.timeStamp) < windowStart) continue
    const from = t.from.toLowerCase()
    const to = t.to.toLowerCase()
    const value = BigInt(t.value)

    if (to !== ZERO_ADDRESS) {
      const f = flows.get(to) ?? { inflow: BigInt(0), outflow: BigInt(0) }
      f.inflow += value
      flows.set(to, f)
    }
    if (from !== ZERO_ADDRESS) {
      const f = flows.get(from) ?? { inflow: BigInt(0), outflow: BigInt(0) }
      f.outflow += value
      flows.set(from, f)
    }
  }

  const result = new Map<string, HolderClassification>()
  const ZERO = BigInt(0)

  for (const [address, balanceRaw] of balances) {
    const f = flows.get(address)
    let behavior: BehaviorLabel

    if (!f || (f.inflow === ZERO && f.outflow === ZERO)) {
      behavior = 'Dormant'
    } else if (f.inflow > ZERO && f.outflow > ZERO) {
      behavior = 'Active'
    } else if (f.inflow > ZERO) {
      behavior = 'Accumulating'
    } else {
      behavior = 'Distributing'
    }

    result.set(address, {
      address,
      behavior,
      balanceRaw: balanceRaw.toString(),
      inflowRaw: (f?.inflow ?? ZERO).toString(),
      outflowRaw: (f?.outflow ?? ZERO).toString(),
      isLabeledCustodian: false,
      nameTag: null,
    })
  }

  return result
}

function legacyComputeAggregateStats(
  transfers: ERC20Transfer[],
  nowTs: number
): {
  holderCount: number
  mix: ReturnType<typeof computeBehavioralMix>
  dormancySharePct: number
  netNewWallets90d: number
  exitedWallets90d: number
  netAccumulationRatio: number | null
} {
  const windowStart = nowTs - WINDOW_SECONDS

  const currentBalances = computeBalances(transfers)
  const historicalBalances = computeBalances(
    transfers.filter((t) => parseInt(t.timeStamp) < windowStart)
  )

  const firstReceipt = new Map<string, number>()
  for (const t of transfers) {
    const to = t.to.toLowerCase()
    if (to === ZERO_ADDRESS) continue
    const ts = parseInt(t.timeStamp)
    const existing = firstReceipt.get(to)
    if (existing === undefined || ts < existing) firstReceipt.set(to, ts)
  }

  let netNewWallets90d = 0
  for (const addr of currentBalances.keys()) {
    const first = firstReceipt.get(addr)
    if (first !== undefined && first >= windowStart) netNewWallets90d++
  }

  let exitedWallets90d = 0
  for (const addr of historicalBalances.keys()) {
    if (!currentBalances.has(addr)) exitedWallets90d++
  }

  const classifications = legacyClassifyHolders(transfers, nowTs)
  const mix = computeBehavioralMix(classifications)
  const dormancySharePct = computeDormancySharePct(classifications)

  const netAccumulationRatio =
    mix.accumulating + mix.distributing > 0
      ? mix.accumulating / (mix.accumulating + mix.distributing)
      : null

  return {
    holderCount: currentBalances.size,
    mix,
    dormancySharePct,
    netNewWallets90d,
    exitedWallets90d,
    netAccumulationRatio,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Assertion helpers
// ──────────────────────────────────────────────────────────────────────────

let failures = 0
const fail = (msg: string) => {
  failures++
  console.error(`  ✗ ${msg}`)
}
const ok = (msg: string) => console.log(`  ✓ ${msg}`)

function assertEqual(label: string, a: unknown, b: unknown) {
  if (a === b) ok(`${label}: ${String(a)}`)
  else fail(`${label}: legacy=${String(a)} new=${String(b)}`)
}

function compareClassifications(
  label: string,
  legacy: Map<string, HolderClassification>,
  next: Map<string, HolderClassification>
) {
  if (legacy.size !== next.size) {
    fail(`${label} classify size: legacy=${legacy.size} new=${next.size}`)
    return
  }
  let mismatched = 0
  for (const [addr, l] of legacy) {
    const n = next.get(addr)
    if (
      !n ||
      n.behavior !== l.behavior ||
      n.balanceRaw !== l.balanceRaw ||
      n.inflowRaw !== l.inflowRaw ||
      n.outflowRaw !== l.outflowRaw
    ) {
      mismatched++
      if (mismatched <= 3)
        fail(`${label} classify mismatch @ ${addr}: ${JSON.stringify(l)} vs ${JSON.stringify(n)}`)
    }
  }
  if (mismatched === 0) ok(`${label} classify: ${legacy.size} holders identical`)
  else fail(`${label} classify: ${mismatched} mismatched holders`)
}

function compareAggregate(
  label: string,
  transfers: ERC20Transfer[],
  nowTs: number
) {
  const legacy = legacyComputeAggregateStats(transfers, nowTs)
  const next = computeAggregateStats(transfers, nowTs)

  console.log(`\n[${label}] nowTs=${nowTs} (${transfers.length} transfers)`)
  assertEqual('holderCount', legacy.holderCount, next.holderCount)
  assertEqual('mix.accumulating', legacy.mix.accumulating, next.mix.accumulating)
  assertEqual('mix.distributing', legacy.mix.distributing, next.mix.distributing)
  assertEqual('mix.dormant', legacy.mix.dormant, next.mix.dormant)
  assertEqual('mix.active', legacy.mix.active, next.mix.active)
  assertEqual('mix.total', legacy.mix.total, next.mix.total)
  assertEqual('dormancySharePct', legacy.dormancySharePct, next.dormancySharePct)
  assertEqual('netNewWallets90d', legacy.netNewWallets90d, next.netNewWallets90d)
  assertEqual('exitedWallets90d', legacy.exitedWallets90d, next.exitedWallets90d)
  assertEqual('netAccumulationRatio', legacy.netAccumulationRatio, next.netAccumulationRatio)

  compareClassifications(label, legacyClassifyHolders(transfers, nowTs), classifyHolders(transfers, nowTs))
}

// ──────────────────────────────────────────────────────────────────────────
// Synthetic fixtures — stress the exitedWallets90d reconstruction.
// ──────────────────────────────────────────────────────────────────────────

function tx(from: string, to: string, value: string, timeStamp: number): ERC20Transfer {
  return {
    blockNumber: '0',
    timeStamp: String(timeStamp),
    hash: '0x',
    from,
    to,
    value,
    contractAddress: '0xtoken',
    tokenName: 'T',
    tokenSymbol: 'T',
    tokenDecimal: '18',
  } as unknown as ERC20Transfer
}

function syntheticFixture(nowTs: number): ERC20Transfer[] {
  const before = nowTs - WINDOW_SECONDS - 1000 // pre-window
  const edge = nowTs - WINDOW_SECONDS // exactly at window start (strict < ⇒ inside window)
  const inside = nowTs - 1000 // inside window
  const A = '0x' + 'a'.repeat(40)
  const B = '0x' + 'b'.repeat(40)
  const C = '0x' + 'c'.repeat(40)
  const D = '0x' + 'd'.repeat(40)
  const E = '0x' + 'e'.repeat(40)
  const F = '0x' + 'f'.repeat(40)

  return [
    // A: pre-window holder who fully exits inside the window  → EXIT
    tx(ZERO_ADDRESS, A, '100', before),
    tx(A, B, '100', inside),
    // B: receives, still holds → current holder, net-new (first receipt inside)
    // C: receives AND fully exits within the window → NOT an exit (held 0 at start)
    tx(ZERO_ADDRESS, C, '50', inside),
    tx(C, B, '50', inside),
    // D: pre-window holder, dormant through window → current, dormant, NOT exit
    tx(ZERO_ADDRESS, D, '70', before),
    // E: exit landing exactly on the window edge timestamp
    tx(ZERO_ADDRESS, E, '40', before),
    tx(E, B, '40', edge),
    // F: pre-window holder partially sheds but keeps a balance → current, not exit
    tx(ZERO_ADDRESS, F, '200', before),
    tx(F, B, '30', inside),
    // burn path: B burns some to zero address inside window (active-ish)
    tx(B, ZERO_ADDRESS, '10', inside),
  ]
}

// ──────────────────────────────────────────────────────────────────────────

function loadUsdy(): ERC20Transfer[] {
  const p = join(
    process.cwd(),
    '.cache/etherscan/transfers-0x96f6ef951840721adbf46ac996b59e0235cb985c.json'
  )
  const parsed = JSON.parse(readFileSync(p, 'utf8'))
  const data: ERC20Transfer[] = parsed.data ?? parsed
  return data
}

function main() {
  console.log('=== classify engine refactor parity gate ===')
  console.log('(legacy oracle vs new wrappers — identical inputs, deep equality)')

  // 1) Synthetic edge cases at a fixed nowTs.
  const synthNow = 2_000_000_000
  compareAggregate('synthetic', syntheticFixture(synthNow), synthNow)

  // 2) Real USDY history across several nowTs so the window straddles real
  //    exits / net-new (the headline USDY check).
  const usdy = loadUsdy()
  const maxTs = usdy.reduce((m, t) => Math.max(m, parseInt(t.timeStamp)), 0)
  const minTs = usdy.reduce((m, t) => Math.min(m, parseInt(t.timeStamp)), Infinity)
  console.log(
    `\nUSDY data: ${usdy.length} transfers, span ${new Date(minTs * 1000).toISOString().slice(0, 10)} → ${new Date(maxTs * 1000).toISOString().slice(0, 10)}`
  )

  compareAggregate('USDY @ maxTs (last 90d of data)', usdy, maxTs)
  compareAggregate('USDY @ maxTs-180d', usdy, maxTs - 180 * 24 * 3600)
  compareAggregate('USDY @ midpoint', usdy, Math.floor((minTs + maxTs) / 2))
  compareAggregate('USDY @ now()', usdy, Math.floor(Date.now() / 1000))

  console.log('\n=== result ===')
  if (failures > 0) {
    console.error(`PARITY FAILED: ${failures} mismatch(es)`)
    process.exit(1)
  }
  console.log('PARITY OK — new wrappers are byte-identical to pre-change behavior.')
}

main()
