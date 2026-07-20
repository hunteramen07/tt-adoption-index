/**
 * rwa.xyz /v4/assets — per-network token supply, the source of the market-value
 * weight used for supply-weighted dormancy (read-layer Phase 2a).
 *
 * WHY THIS EXISTS. The weight was previously self-computed as Σ(positive holder
 * balances) × NAV from the merged incremental state. That state is derived from
 * /v4/transactions, which on Solana emits each transfer through two parallel
 * feeds — one keyed by associated token account, one by owner wallet — with
 * asymmetric mint/burn coverage. Positions therefore double-count, and orphaned
 * mints never net out (USYC Solana summed 26.9M tokens against a real mint supply
 * of 101). /v4/assets is independently chain-indexed, not derived from that feed,
 * so it is immune to the duplication. Verified against chain totalSupply /
 * getTokenSupply: within 0.03–0.74% on the material networks.
 *
 * TWO SHAPE HAZARDS this module exists to absorb:
 *
 *  1. `tokens[]` is keyed by TOKEN ADDRESS, never network_id. BUIDL's array holds
 *     TWO entries on network_id 1 — the tracked class (0x7712c342…) and the
 *     restricted BUIDL-I class (0x6a9da2d7…, ~5× larger). Keying by network would
 *     silently swallow BUIDL-I. Address-keying is the same exclusion mechanism
 *     fetchTransfersRWA already applies to the transactions feed.
 *  2. Metrics are OBJECTS, not scalars — `{val, val_7d, val_30d, chg_7d_pct, …}`.
 *     The current figure is `.val`.
 */

import { fetchRwaJson } from '@/src/lib/rwa/http'

const ASSETS_URL = 'https://api.rwa.xyz/v4/assets'

/** rwa.xyz metric envelope — current value plus trailing comparisons. */
interface RwaMetric {
  val: number | null
}

/** Subset of an /v4/assets `tokens[]` entry that we actually read. */
interface RwaAssetToken {
  address: string
  decimals: number
  network_id: number
  network_name: string | null
  /** Decimal-adjusted token supply, NOT raw units. Null on networks rwa has no stats for. */
  total_supply_token: RwaMetric | null
}

interface RwaAssetsResponse {
  results: Array<{ tokens: RwaAssetToken[] }>
}

/** Per-token supply as reported by /v4/assets, keyed by lowercased address. */
export interface TokenSupply {
  /** Decimal-adjusted token count (already divided by 10^decimals). */
  supplyTokens: number
  networkId: number
  networkName: string | null
  /** rwa.xyz's decimals for this token — asserted against config by sumSupplyForNetwork. */
  decimals: number
}

/**
 * Fetch one asset's per-network token supply. ONE request per fund — call this
 * once and thread the map through the per-network loop, never per network.
 *
 * @param assetId rwa.xyz asset_id (Product.rwaAssetId)
 * @returns map of lowercased token address → supply. Tokens whose
 *          total_supply_token is null are OMITTED, so a caller summing an
 *          unknown address gets null rather than a silent zero.
 */
export async function fetchAssetSupplyByToken(assetId: number): Promise<Map<string, TokenSupply>> {
  const apiKey = process.env.RWA_API_KEY
  if (!apiKey) throw new Error('RWA_API_KEY environment variable is not set')

  const query = {
    filter: { operator: 'and', filters: [{ operator: 'equals', field: 'id', value: assetId }] },
    pagination: { page: 1, perPage: 1 },
  }
  const url = `${ASSETS_URL}?query=${encodeURIComponent(JSON.stringify(query))}`

  const data = await fetchRwaJson<RwaAssetsResponse>(url, '/v4/assets', 1, apiKey)

  const asset = data.results?.[0]
  if (!asset) throw new Error(`rwa.xyz /v4/assets returned no result for asset_id ${assetId}`)

  const out = new Map<string, TokenSupply>()
  for (const token of asset.tokens ?? []) {
    const supply = token.total_supply_token?.val
    if (supply == null) continue // omit → caller reports an explicit null-supply error
    out.set(token.address.toLowerCase(), {
      supplyTokens: supply,
      networkId: token.network_id,
      networkName: token.network_name,
      decimals: token.decimals,
    })
  }
  return out
}

/**
 * Sum the supply of a network's configured token addresses.
 *
 * SUMS rather than taking the first match, so funds with several tracked
 * contracts on one network (e.g. USDY's native + Certificate on Ethereum) get
 * their full supply. Addresses absent from the map contribute nothing and are
 * reported via `missing` — the caller logs an explicit error naming fund and
 * network rather than letting a partial sum pass as complete.
 *
 * Asserts rwa.xyz's decimals against the configured value, mirroring the
 * fetch-time guard in fetchTransfersRWA: a wrong/stale config value would
 * mis-scale the weight by a power of ten, so it fails loudly.
 */
export function sumSupplyForNetwork(
  supplyByToken: Map<string, TokenSupply>,
  addresses: string[],
  decimals: number,
  context: string
): { supplyTokens: number | null; missing: string[] } {
  let total = 0
  let matched = 0
  const missing: string[] = []

  for (const address of addresses) {
    const entry = supplyByToken.get(address.toLowerCase())
    if (!entry) {
      missing.push(address)
      continue
    }
    if (entry.decimals !== decimals) {
      throw new Error(
        `[${context}] rwa.xyz /v4/assets decimals mismatch (token ${address}): ` +
        `config ${decimals} vs rwa.xyz ${entry.decimals}`
      )
    }
    total += entry.supplyTokens
    matched++
  }

  return { supplyTokens: matched > 0 ? total : null, missing }
}
