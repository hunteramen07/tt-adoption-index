import type { ERC20Transfer } from '@/src/lib/etherscan/types'
import { computeBalances } from '@/src/lib/etherscan/balances'
import type {
  BehaviorLabel,
  BehavioralMix,
  HolderClassification,
} from './types'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const WINDOW_SECONDS = 90 * 24 * 3600

/**
 * Classify all current token holders over the trailing 90-day window.
 *
 * Classification priority (mutually exclusive):
 *   Dormant      — zero in AND zero out in the window
 *   Active       — both in > 0 AND out > 0 ("two-way flow")
 *   Accumulating — in > 0, out = 0
 *   Distributing — in = 0, out > 0
 *
 * nameTag and isLabeledCustodian are left as defaults; the caller is
 * responsible for enriching them via name tag resolution.
 */
export function classifyHolders(
  transfers: ERC20Transfer[],
  nowTs: number = Math.floor(Date.now() / 1000)
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

/**
 * Fraction of total supply held by addresses with no outbound in the window.
 * Input to the Dormancy index factor. Includes both Dormant and Accumulating.
 */
export function computeDormancySharePct(
  classifications: Map<string, HolderClassification>
): number {
  let noOutbound = BigInt(0)
  let total = BigInt(0)

  for (const c of classifications.values()) {
    const bal = BigInt(c.balanceRaw)
    total += bal
    if (c.behavior === 'Dormant' || c.behavior === 'Accumulating') {
      noOutbound += bal
    }
  }

  if (total === BigInt(0)) return 0
  return Number((noOutbound * BigInt(10000)) / total) / 100
}

/** Count each behavior label across a classification map. */
export function computeBehavioralMix(
  classifications: Map<string, HolderClassification>
): BehavioralMix {
  let accumulating = 0
  let distributing = 0
  let dormant = 0
  let active = 0

  for (const c of classifications.values()) {
    if (c.behavior === 'Accumulating') accumulating++
    else if (c.behavior === 'Distributing') distributing++
    else if (c.behavior === 'Dormant') dormant++
    else active++
  }

  return { accumulating, distributing, dormant, active, total: classifications.size }
}

/**
 * Compute aggregate behavioral stats for products where per-wallet rows are
 * not written (e.g. USDY). All metrics are derived from the full transfer
 * history without additional API calls.
 */
export function computeAggregateStats(
  transfers: ERC20Transfer[],
  nowTs: number = Math.floor(Date.now() / 1000)
): {
  holderCount: number
  mix: BehavioralMix
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

  // Net new: current holders whose first token receipt is inside the window
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

  // Exited: had positive balance at window start, now zero
  let exitedWallets90d = 0
  for (const addr of historicalBalances.keys()) {
    if (!currentBalances.has(addr)) exitedWallets90d++
  }

  const classifications = classifyHolders(transfers, nowTs)
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
