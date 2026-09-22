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
 * of 101). /v4/assets is an AGGREGATE figure, so it carries none of that
 * per-position keying hazard — which is what makes it a sound weight.
 *
 * WHAT IT IS NOT: an independent reference. This header used to claim /v4/assets
 * is "independently chain-indexed, not derived from that feed". On Solana that is
 * FALSE (read-only probe 2026-09-10): a net replay of /v4/transactions matches
 * /v4/assets to 1e-6 on both buidl:solana (946,212,811.19 vs 946,212,811.1899993)
 * and ustb:solana (198,105.787922 vs 198,105.78792199987) — both endpoints are
 * served from the same rwa.xyz ledger. Meanwhile chain getTokenSupply read
 * 992,508,734.52 (BUIDL 4.66% ABOVE rwa) and 174,247.82 (USTB 13.69% BELOW rwa).
 * The earlier "within 0.03–0.74% of chain" figure was measured on the EVM networks
 * and does not hold on Solana. Consequently:
 *   • the market-value WEIGHT still comes from here (it is the supply rwa.xyz
 *     reports and the dashboard already shows), but
 *   • the reconciliation TRIPWIRE does NOT reconcile against it — checking a
 *     replay of rwa's feed against rwa's aggregate is tautological. It reconciles
 *     against on-chain supply (src/lib/rwa/chain-supply.ts) and reports the
 *     assets-vs-chain delta as an informational measure of rwa.xyz's own gap.
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
export interface RwaMetric {
  val: number | null
  /** The same figure 7 days ago; what the cursor-age tripwire reads activity from. */
  val_7d?: number | null
}

/**
 * Subset of an /v4/assets `tokens[]` entry that we read. Exported RAW (with the
 * null-supply entries kept) for the chain-coverage check — a newly listed network
 * arrives with stats still null, which is exactly the entry that check must see.
 */
export interface RwaAssetToken {
  address: string
  decimals: number
  network_id: number
  network_name: string | null
  /** Present on live responses (probe 2026-09-21); the slug is what config keys on. */
  network?: { slug?: string | null } | null
  /** Decimal-adjusted token supply, NOT raw units. Null on networks rwa has no stats for. */
  total_supply_token: RwaMetric | null
  /** USD value of the supply as rwa.xyz prices it; null/0 on some funds (BUIDL, USTB). */
  market_value_dollar?: RwaMetric | null
  holding_addresses_count?: RwaMetric | null
}

interface RwaAssetsResponse {
  results: Array<{ tokens: RwaAssetToken[] }>
}

/** Per-token supply as reported by /v4/assets, keyed by lowercased address. */
export interface TokenSupply {
  /** Decimal-adjusted token count (already divided by 10^decimals). */
  supplyTokens: number
  /** The same, 7 days ago — null when rwa.xyz did not report it. */
  supplyTokens7dAgo: number | null
  holdersCount: number | null
  holdersCount7dAgo: number | null
  networkId: number
  networkName: string | null
  /** rwa.xyz's decimals for this token — asserted against config by sumSupplyForNetwork. */
  decimals: number
}

/**
 * Fetch one asset's raw per-network token list. ONE request per fund — call this
 * once and derive everything else (supply map, coverage check) from the result.
 */
export async function fetchAssetTokens(assetId: number): Promise<RwaAssetToken[]> {
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
  return asset.tokens ?? []
}

/**
 * The supply map the per-network loop reads, from a raw token list. Tokens whose
 * total_supply_token is null are OMITTED, so a caller summing an unknown address
 * gets null rather than a silent zero.
 */
export function supplyByTokenFrom(tokens: readonly RwaAssetToken[]): Map<string, TokenSupply> {
  const out = new Map<string, TokenSupply>()
  for (const token of tokens) {
    const supply = token.total_supply_token?.val
    if (supply == null) continue // omit → caller reports an explicit null-supply error
    out.set(token.address.toLowerCase(), {
      supplyTokens: supply,
      supplyTokens7dAgo: token.total_supply_token?.val_7d ?? null,
      holdersCount: token.holding_addresses_count?.val ?? null,
      holdersCount7dAgo: token.holding_addresses_count?.val_7d ?? null,
      networkId: token.network_id,
      networkName: token.network_name,
      decimals: token.decimals,
    })
  }
  return out
}

/**
 * Fetch one asset's per-network token supply, keyed by lowercased address. ONE
 * request per fund — thread the map through the per-network loop, never per network.
 */
export async function fetchAssetSupplyByToken(assetId: number): Promise<Map<string, TokenSupply>> {
  return supplyByTokenFrom(await fetchAssetTokens(assetId))
}

/**
 * Did rwa.xyz see this network's supply or holder count move in the last 7 days?
 * The cursor-age tripwire's activity signal: a cursor that has not advanced while
 * the feed's own aggregates moved is frozen, not quiet. Null when no configured
 * token has both figures (nothing can be said either way).
 */
export function networkActivity7d(
  supplyByToken: Map<string, TokenSupply>,
  addresses: readonly string[]
): { supplyMoved: boolean; holdersMoved: boolean } | null {
  let seen = false
  let supplyMoved = false
  let holdersMoved = false
  for (const address of addresses) {
    const e = supplyByToken.get(address.toLowerCase())
    if (!e) continue
    if (e.supplyTokens7dAgo != null) {
      seen = true
      // Relative, so a float32-rounded feed (XRPL) does not register as movement.
      const scale = Math.max(Math.abs(e.supplyTokens), Math.abs(e.supplyTokens7dAgo), 1)
      if (Math.abs(e.supplyTokens - e.supplyTokens7dAgo) / scale > 1e-9) supplyMoved = true
    }
    if (e.holdersCount != null && e.holdersCount7dAgo != null) {
      seen = true
      if (e.holdersCount !== e.holdersCount7dAgo) holdersMoved = true
    }
  }
  return seen ? { supplyMoved, holdersMoved } : null
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
