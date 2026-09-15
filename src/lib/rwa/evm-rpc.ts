/**
 * EVM JSON-RPC — public endpoints per tracked network and the two ERC-20 reads the
 * reconciliation tripwire needs: totalSupply() and decimals().
 *
 * WHY PUBLIC RPC AND NOT AN INDEXER. The tripwire's whole job is to compare our
 * holder state against something that does NOT share a pipeline with rwa.xyz. An
 * eth_call answered by a node is the chain itself; Etherscan/rwa.xyz are indexers
 * with their own lag and gaps. Two endpoints per network (publicnode first, drpc
 * second — drpc rate-limits BNB and intermittently 5xxs Sei/Mantle, probe
 * 2026-09-14) plus the network's own public RPC where one exists. Override per
 * network with EVM_RPC_URLS_<SLUG> (slug upper-cased, '-' → '_', e.g.
 * EVM_RPC_URLS_AVALANCHE_C_CHAIN), comma-separated.
 *
 * Networks WITHOUT an entry here (Aptos, Stellar, XRPL, Noble, Sui, Mantra) have no
 * chain reference: the tripwire SKIPS them (logged, persisted as such) rather than
 * falling back to /v4/assets, which is not independent of the state under test.
 */

import { jsonRpc, endpointsFromEnv } from '@/src/lib/rwa/json-rpc'

/** Keyed by rwa.xyz network_id, matching src/config/networks.ts / products.ts. */
const DEFAULT_EVM_ENDPOINTS: Record<number, { slug: string; urls: string[] }> = {
  1: { slug: 'ethereum', urls: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://eth.llamarpc.com'] },
  3: { slug: 'polygon', urls: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'] },
  4: { slug: 'optimism', urls: ['https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'] },
  5: { slug: 'avalanche-c-chain', urls: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://avalanche.drpc.org'] },
  8: { slug: 'bnb-chain', urls: ['https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org'] },
  11: { slug: 'arbitrum', urls: ['https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'] },
  33: { slug: 'mantle', urls: ['https://mantle-rpc.publicnode.com', 'https://mantle.drpc.org'] },
  48: { slug: 'plume', urls: ['https://rpc.plume.org', 'https://plume.drpc.org'] },
  70: { slug: 'sei', urls: ['https://evm-rpc.sei-apis.com', 'https://sei-evm-rpc.publicnode.com', 'https://sei.drpc.org'] },
}

/** Endpoints for an EVM network, or null when we have no reference for it. */
export function evmEndpoints(networkId: number): string[] | null {
  const entry = DEFAULT_EVM_ENDPOINTS[networkId]
  if (!entry) return null
  const envName = `EVM_RPC_URLS_${entry.slug.toUpperCase().replace(/-/g, '_')}`
  return endpointsFromEnv(envName) ?? entry.urls
}

// 4-byte selectors: totalSupply() / decimals().
const SEL_TOTAL_SUPPLY = '0x18160ddd'
const SEL_DECIMALS = '0x313ce567'

/** A 32-byte ABI-encoded uint as returned by eth_call, or undefined if malformed. */
const pickUint = (r: unknown): bigint | undefined => {
  if (typeof r !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r)) return undefined
  return BigInt(r)
}

async function ethCallUint(to: string, data: string, endpoints: string[]): Promise<bigint> {
  return jsonRpc({
    label: '[evm-rpc]',
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
    pick: pickUint,
    endpoints,
  })
}

/** ERC-20 totalSupply() in raw base units. */
export async function erc20TotalSupply(token: string, endpoints: string[]): Promise<bigint> {
  return ethCallUint(token, SEL_TOTAL_SUPPLY, endpoints)
}

/** ERC-20 decimals(). */
export async function erc20Decimals(token: string, endpoints: string[]): Promise<number> {
  return Number(await ethCallUint(token, SEL_DECIMALS, endpoints))
}
