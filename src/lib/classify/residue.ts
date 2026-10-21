/**
 * Residue-floor counting helper. The floor itself (10^(decimals + exponent) raw
 * units, per network) comes from residueFloorRaw in src/config/networks.ts; this
 * module only applies it, so the engine and the Etherscan balance derivation can
 * share one rule without importing each other.
 *
 * A wallet is a holder iff its raw balance is STRICTLY ABOVE the floor. At
 * ZERO_FLOOR that is the historical positive-balance rule, which is what every
 * default call site and the parity gates still use.
 */

export const ZERO_FLOOR = BigInt(0)

/** True when `raw` counts as a holder balance under `floorRaw`. */
export const isHolderBalance = (raw: bigint, floorRaw: bigint = ZERO_FLOOR): boolean => raw > floorRaw

/**
 * Count the holders in a balance collection — bare bigints or `{ balance }` state
 * rows (BalanceStateMap values) — under `floorRaw`. Pass `map.values()`.
 */
export function countHolders(
  balances: Iterable<bigint | { balance: bigint }>,
  floorRaw: bigint = ZERO_FLOOR
): number {
  let n = 0
  for (const b of balances) {
    if (isHolderBalance(typeof b === 'bigint' ? b : b.balance, floorRaw)) n++
  }
  return n
}
