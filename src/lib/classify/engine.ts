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
 * Canonicalize a holder address for use as a map key. Hex (EVM/Aptos/Sui) and
 * bech32 (Noble) addresses are case-insensitive, so they are lowercased to unify
 * mixed-case appearances of the same wallet. Case-sensitive encodings — base58
 * (Solana, XRPL) and base32/StrKey (Stellar) — MUST be preserved verbatim, or
 * distinct wallets collide and one wallet can split. `caseSensitive` defaults to
 * false so every existing (EVM) call site stays byte-identical.
 *
 * The zero-address sentinel ('0x000…0') is already lowercase hex and mint/burn
 * counterparties are coerced to that exact string upstream, so `=== ZERO_ADDRESS`
 * comparisons still match even when caseSensitive is true (the string is untouched
 * and no base58 address collides with it).
 */
export const normalizeAddress = (addr: string, caseSensitive = false): string =>
  caseSensitive ? addr : addr.toLowerCase()

/**
 * Classify holders over the trailing 90-day window from precomputed state.
 *
 * Balances are supplied precomputed (e.g. from holder_balance_state); flows are
 * derived from the separately-fetched trailing-90d transfer set. This is the
 * core used by both the full-history wrapper and the incremental fetch path.
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
export function classifyHoldersFromState(
  balances: Map<string, bigint>,
  windowTransfers: ERC20Transfer[],
  nowTs: number = Math.floor(Date.now() / 1000),
  caseSensitive = false
): Map<string, HolderClassification> {
  const windowStart = nowTs - WINDOW_SECONDS
  type Flows = { inflow: bigint; outflow: bigint }
  const flows = new Map<string, Flows>()
  const ZERO = BigInt(0)

  for (const t of windowTransfers) {
    if (parseInt(t.timeStamp) < windowStart) continue // safety filter; set is already trimmed
    const from = normalizeAddress(t.from, caseSensitive)
    const to = normalizeAddress(t.to, caseSensitive)
    const value = BigInt(t.value)
    if (to !== ZERO_ADDRESS) {
      const f = flows.get(to) ?? { inflow: ZERO, outflow: ZERO }
      f.inflow += value
      flows.set(to, f)
    }
    if (from !== ZERO_ADDRESS) {
      const f = flows.get(from) ?? { inflow: ZERO, outflow: ZERO }
      f.outflow += value
      flows.set(from, f)
    }
  }

  const result = new Map<string, HolderClassification>()
  for (const [address, balanceRaw] of balances) {
    const f = flows.get(address)
    let behavior: BehaviorLabel
    if (!f || (f.inflow === ZERO && f.outflow === ZERO)) behavior = 'Dormant'
    else if (f.inflow > ZERO && f.outflow > ZERO) behavior = 'Active'
    else if (f.inflow > ZERO) behavior = 'Accumulating'
    else behavior = 'Distributing'
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
 * Classify all current token holders over the trailing 90-day window.
 * Thin wrapper — unchanged behavior for existing callers: computes balances
 * from the full transfer history, then delegates to classifyHoldersFromState.
 */
export function classifyHolders(
  transfers: ERC20Transfer[],
  nowTs: number = Math.floor(Date.now() / 1000)
): Map<string, HolderClassification> {
  return classifyHoldersFromState(computeBalances(transfers), transfers, nowTs)
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
 * Compute aggregate behavioral stats from precomputed holder state. Balances
 * carry {balance, firstReceipt}; window flows come from windowTransfers. Core
 * used by both the full-history wrapper and the incremental fetch path.
 */
export function computeAggregateStatsFromState(
  balances: Map<string, { balance: bigint; firstReceipt: number | null }>,
  windowTransfers: ERC20Transfer[],
  nowTs: number = Math.floor(Date.now() / 1000),
  caseSensitive = false
): {
  holderCount: number
  mix: BehavioralMix
  dormancySharePct: number
  netNewWallets90d: number
  exitedWallets90d: number
  netAccumulationRatio: number | null
} {
  const windowStart = nowTs - WINDOW_SECONDS
  const ZERO = BigInt(0)

  // Classify from the balance map (drop first_receipt for the classify call).
  const balanceMap = new Map<string, bigint>()
  for (const [addr, s] of balances) balanceMap.set(addr, s.balance)
  const classifications = classifyHoldersFromState(balanceMap, windowTransfers, nowTs, caseSensitive)
  const mix = computeBehavioralMix(classifications)
  const dormancySharePct = computeDormancySharePct(classifications)
  const netAccumulationRatio =
    mix.accumulating + mix.distributing > 0
      ? mix.accumulating / (mix.accumulating + mix.distributing)
      : null

  // Net new: current holders whose first-ever receipt is inside the window.
  let netNewWallets90d = 0
  for (const s of balances.values()) {
    if (s.firstReceipt !== null && s.firstReceipt >= windowStart) netNewWallets90d++
  }

  // ── exitedWallets90d: window-start-balance reconstruction (NEW logic) ──────
  // A wallet exited iff it held > 0 at window start but holds nothing now.
  // We have no pre-window history, so reconstruct window-start balance from the
  // CURRENT balance and the NET window flow:
  //     balanceAtStart = balanceNow - (inflowWindow - outflowWindow)
  // Only NON-current addresses can be exits (current holders still hold > 0),
  // and for those balanceNow = 0, so:
  //     balanceAtStart = outflowWindow - inflowWindow   ( > 0 ⇒ net-shed ⇒ exit)
  //
  // Boundary cases:
  //  • received AND fully exited within the window (no pre-window balance):
  //      inflow == outflow ⇒ balanceAtStart 0 ⇒ NOT counted (correct — held
  //      nothing at window start).
  //  • exit exactly at the window edge (timeStamp === windowStart): the same
  //      strict `< windowStart` split used everywhere keeps the edge transfer
  //      INSIDE the window, matching the original historical filter
  //      (computeBalances(transfers.filter(ts < windowStart))) exactly.
  type Flow = { inflow: bigint; outflow: bigint }
  const windowFlow = new Map<string, Flow>()
  for (const t of windowTransfers) {
    if (parseInt(t.timeStamp) < windowStart) continue
    const from = normalizeAddress(t.from, caseSensitive)
    const to = normalizeAddress(t.to, caseSensitive)
    const value = BigInt(t.value)
    if (to !== ZERO_ADDRESS) {
      const f = windowFlow.get(to) ?? { inflow: ZERO, outflow: ZERO }
      f.inflow += value
      windowFlow.set(to, f)
    }
    if (from !== ZERO_ADDRESS) {
      const f = windowFlow.get(from) ?? { inflow: ZERO, outflow: ZERO }
      f.outflow += value
      windowFlow.set(from, f)
    }
  }

  let exitedWallets90d = 0
  for (const [addr, f] of windowFlow) {
    if (balances.has(addr)) continue // still a current holder ⇒ not exited
    const balanceAtStart = f.outflow - f.inflow // = 0 - netFlow, since balanceNow = 0
    if (balanceAtStart > ZERO) exitedWallets90d++
  }

  return {
    holderCount: balances.size,
    mix,
    dormancySharePct,
    netNewWallets90d,
    exitedWallets90d,
    netAccumulationRatio,
  }
}

/**
 * Compute aggregate behavioral stats for products where per-wallet rows are
 * not written (e.g. USDY). Thin wrapper — builds the {balance, firstReceipt}
 * state from full history then delegates, preserving the original behavior
 * exactly. All metrics are derived without additional API calls.
 */
export function computeAggregateStats(
  transfers: ERC20Transfer[],
  nowTs: number = Math.floor(Date.now() / 1000)
) {
  const balances = computeBalances(transfers)
  const firstReceipt = new Map<string, number>()
  for (const t of transfers) {
    const to = t.to.toLowerCase()
    if (to === ZERO_ADDRESS) continue
    const ts = parseInt(t.timeStamp)
    const existing = firstReceipt.get(to)
    if (existing === undefined || ts < existing) firstReceipt.set(to, ts)
  }
  const state = new Map<string, { balance: bigint; firstReceipt: number | null }>()
  for (const [addr, bal] of balances) {
    state.set(addr, { balance: bal, firstReceipt: firstReceipt.get(addr) ?? null })
  }
  return computeAggregateStatsFromState(state, transfers, nowTs)
}
