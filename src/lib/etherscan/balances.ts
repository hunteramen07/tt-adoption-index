import type { ERC20Transfer, EnrichedHolder } from './types'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Computes current token balances for every address by replaying transfers.
 * Mints (from = zero address) and burns (to = zero address) are handled
 * correctly. Returns only addresses with a positive balance.
 */
export function computeBalances(
  transfers: ERC20Transfer[]
): Map<string, bigint> {
  const balances = new Map<string, bigint>()

  for (const t of transfers) {
    const from = t.from.toLowerCase()
    const to = t.to.toLowerCase()
    const value = BigInt(t.value)

    if (from !== ZERO_ADDRESS) {
      balances.set(from, (balances.get(from) ?? BigInt(0)) - value)
    }
    if (to !== ZERO_ADDRESS) {
      balances.set(to, (balances.get(to) ?? BigInt(0)) + value)
    }
  }

  for (const [addr, bal] of balances) {
    if (bal <= BigInt(0)) balances.delete(addr)
  }

  return balances
}

export interface DerivedHolderStats {
  holderCount: number
  topHolders: EnrichedHolder[]
}

/**
 * Derives holder count and top-N holders from on-chain transfer history.
 * Used on the free API tier as a replacement for the Pro-only
 * tokenholdercount / tokenholderlist endpoints.
 *
 * Accuracy note: matches Etherscan's holder list for fully on-chain products.
 * Products that use off-chain bookkeeping may differ.
 */
export function deriveHolderStats(
  transfers: ERC20Transfer[],
  totalSupplyRaw: string,
  decimals: number,
  productSlug: string,
  topN = 10
): DerivedHolderStats {
  const balances = computeBalances(transfers)
  const holderCount = balances.size

  if (holderCount === 0) return { holderCount: 0, topHolders: [] }

  const sorted = Array.from(balances.entries()).sort((a, b) =>
    a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0
  )

  const supplyBig = BigInt(totalSupplyRaw || '0')
  const divisor = BigInt(10) ** BigInt(decimals)

  const topHolders: EnrichedHolder[] = sorted
    .slice(0, topN)
    .map(([address, raw]): EnrichedHolder => {
      const shareOfSupply =
        supplyBig > BigInt(0)
          ? Number((raw * BigInt(10000)) / supplyBig) / 100
          : 0

      const whole = raw / divisor
      const frac = (raw % divisor).toString().padStart(decimals, '0').slice(0, 4)

      return {
        address,
        balance: `${whole}.${frac}`,
        balanceRaw: raw.toString(),
        shareOfSupply,
        nameTag: null,
      }
    })

  return { holderCount, topHolders }
}
