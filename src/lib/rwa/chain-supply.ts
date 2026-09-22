/**
 * On-chain token supply per (fund, network) — the reconciliation tripwire's
 * INDEPENDENT reference.
 *
 * WHY NOT /v4/assets. Both /v4/transactions (what holder state is replayed from) and
 * /v4/assets (the market-value weight) are served from rwa.xyz's own ledger: on
 * Solana a net replay of the transactions feed matches /v4/assets to 1e-6 on both
 * BUIDL and USTB (probe 2026-09-10), while chain getTokenSupply sits 4.66% above /
 * 13.69% below respectively. A tripwire that reconciles rwa against rwa is
 * tautological — it can only ever see OUR replay bugs, never rwa's indexing gaps,
 * and it passed while both of those gaps were live. Chain supply is the one number
 * that does not share a pipeline with the state under test.
 *
 * WHAT COUNTS AS A REFERENCE.
 *   • Solana  — getTokenSupply on the mint (solana-rpc.ts)
 *   • EVM     — totalSupply() via eth_call (evm-rpc.ts), summed over the network's
 *               configured contracts (USDY has two on Ethereum)
 *   • XRPL    — the issuer's obligation in the product's symbol via gateway_balances
 *               (xrpl-rpc.ts); the configured token address IS the issuer. Added
 *               2026-09-21 so the tripwire is no longer blind on OUSG's largest chain.
 *   • anything else (Stellar, Aptos, Noble, Sui, Mantra) — NO reference: returns
 *               null. The caller SKIPS the tripwire for that network (logged +
 *               persisted as skipped) rather than falling back to /v4/assets. A skip is honest; a fallback would silently reinstate
 *               the tautology on exactly the networks we cannot check.
 *
 * Decimals are asserted against config on every read, mirroring the guards in
 * fetchTransfersRWA and sumSupplyForNetwork: a wrong config value would mis-scale
 * the deviation by a power of ten, so it fails loudly instead. XRPL is the exception:
 * its amounts are decimal strings with no on-chain decimals field, so the configured
 * value is applied by exact string arithmetic (see xrpl-rpc.ts).
 */

import { SOLANA_NETWORK_ID } from '@/src/lib/rwa/solana-resolve'
import { getTokenSupply } from '@/src/lib/rwa/solana-rpc'
import { evmEndpoints, erc20TotalSupply, erc20Decimals } from '@/src/lib/rwa/evm-rpc'
import { XRPL_NETWORK_ID, xrplIssuedSupply } from '@/src/lib/rwa/xrpl-rpc'

export interface ChainSupply {
  /** Decimal-adjusted token count, summed over the network's configured contracts. */
  supplyTokens: number
  /** Raw base units, exact. */
  supplyRaw: bigint
  /** Which read produced it — recorded with every persisted tripwire row. */
  reference: 'solana:getTokenSupply' | 'evm:totalSupply' | 'xrpl:gateway_balances'
}

/** Exact bigint→token conversion; Number(raw) alone loses precision past 2^53. */
export function toTokens(raw: bigint, decimals: number): number {
  const scale = BigInt(10) ** BigInt(decimals)
  return Number(raw / scale) + Number(raw % scale) / Number(scale)
}

/**
 * Read a network's on-chain supply, or null when the network has no reference
 * (see header). Throws on RPC failure or a decimals mismatch — the caller treats a
 * throw as "reference unavailable this run" and skips, it never substitutes.
 *
 * `symbol` is the product's ticker; only XRPL reads it (it selects the issuer's
 * obligation). An XRPL network without it returns null rather than guessing which
 * of the issuer's currencies is the fund.
 */
export async function fetchChainSupply(
  networkId: number,
  addresses: string[],
  decimals: number,
  context: string,
  symbol?: string
): Promise<ChainSupply | null> {
  const assertDecimals = (address: string, onChain: number) => {
    if (onChain !== decimals) {
      throw new Error(
        `[${context}] on-chain decimals mismatch (token ${address}): config ${decimals} vs chain ${onChain}`
      )
    }
  }

  if (networkId === SOLANA_NETWORK_ID) {
    let raw = BigInt(0)
    for (const mint of addresses) {
      const s = await getTokenSupply(mint)
      assertDecimals(mint, s.decimals)
      raw += BigInt(s.amount)
    }
    return { supplyTokens: toTokens(raw, decimals), supplyRaw: raw, reference: 'solana:getTokenSupply' }
  }

  if (networkId === XRPL_NETWORK_ID) {
    if (!symbol) return null
    // rwa.xyz's XRPL token address is the issuer account; a fund has one per network.
    let raw = BigInt(0)
    for (const issuer of addresses) raw += (await xrplIssuedSupply(issuer, symbol, decimals)).supplyRaw
    return { supplyTokens: toTokens(raw, decimals), supplyRaw: raw, reference: 'xrpl:gateway_balances' }
  }

  const endpoints = evmEndpoints(networkId)
  if (!endpoints) return null

  let raw = BigInt(0)
  for (const token of addresses) {
    assertDecimals(token, await erc20Decimals(token, endpoints))
    raw += await erc20TotalSupply(token, endpoints)
  }
  return { supplyTokens: toTokens(raw, decimals), supplyRaw: raw, reference: 'evm:totalSupply' }
}
