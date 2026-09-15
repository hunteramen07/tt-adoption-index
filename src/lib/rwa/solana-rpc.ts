/**
 * Solana JSON-RPC — endpoint list and the typed method wrappers the pipeline reads
 * chain through: getMultipleAccounts (ATA→owner resolution) and getTokenSupply (the
 * reconciliation tripwire's independent reference).
 *
 * Lifted out of solana-resolve.ts so the resolver and the supply read share ONE
 * endpoint list and ONE failure policy (json-rpc.ts) instead of drifting apart.
 * Semantics of the original in-resolver call are unchanged: every endpoint is tried
 * in order, twice each, with a per-attempt timeout; only an all-endpoint failure
 * throws, and nothing here ever guesses on failure.
 */

import { jsonRpc, endpointsFromEnv } from '@/src/lib/rwa/json-rpc'

// ⚠ Fragile in practice (probed 2026-09-15 with the resolver's real 100-address
// getMultipleAccounts batch): only api.mainnet-beta answers. publicnode returns 403
// "Request blocked" for any batch above ~10 addresses (it accepts 10, blocks 25), and
// drpc answers "chain is not available on free plan". So there is effectively ONE
// endpoint; if it rate-limits, the whole resolution fails (the backfill treats that as
// a window-size failure and halves the span — it does NOT end the run, see
// isChainRpcFailure in scripts/classify.ts). Set SOLANA_RPC_URLS (comma-separated, e.g.
// a keyed Helius/QuickNode/Alchemy URL first) as a workflow secret to add real fallback.
const DEFAULT_RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
]

/** RPC endpoints, overridable via SOLANA_RPC_URLS (comma-separated). */
export function rpcEndpoints(): string[] {
  return endpointsFromEnv('SOLANA_RPC_URLS') ?? DEFAULT_RPC_ENDPOINTS
}

/** The subset of a jsonParsed account that resolution reads. */
export interface ParsedAccount {
  owner: string
  data?: { parsed?: { type?: string; info?: { owner?: string } } }
}

/** One getMultipleAccounts call (≤100 addresses) with endpoint fallback + retry.
 *  Throws if EVERY endpoint fails — resolution never guesses on RPC failure. */
export async function getMultipleAccounts(addresses: string[], endpoints: string[]): Promise<(ParsedAccount | null)[]> {
  return jsonRpc({
    label: '[solana-resolve]',
    method: 'getMultipleAccounts',
    params: [addresses, { encoding: 'jsonParsed' }],
    pick: (r) => (r as { value?: (ParsedAccount | null)[] } | undefined)?.value || undefined,
    endpoints,
  })
}

/** Mint supply as the token program reports it: raw base units + the mint's decimals. */
export interface TokenSupplyOnChain {
  /** Raw base units (bigint-safe string), NOT decimal-adjusted. */
  amount: string
  decimals: number
}

/** One getTokenSupply call for a mint. Same fallback/retry contract as above. */
export async function getTokenSupply(mint: string, endpoints: string[] = rpcEndpoints()): Promise<TokenSupplyOnChain> {
  return jsonRpc({
    label: '[solana-rpc]',
    method: 'getTokenSupply',
    params: [mint],
    pick: (r) => {
      const v = (r as { value?: { amount?: unknown; decimals?: unknown } } | undefined)?.value
      return typeof v?.amount === 'string' && typeof v.decimals === 'number'
        ? { amount: v.amount, decimals: v.decimals }
        : undefined
    },
    endpoints,
  })
}
