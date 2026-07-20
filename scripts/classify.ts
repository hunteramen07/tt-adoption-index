/**
 * npm run classify
 *
 * Classifies all token holder addresses for BUIDL, OUSG, USTB, USYC
 * (per-wallet rows) and USDY (aggregate stats only), then writes results
 * to Supabase.
 *
 * Fetch paths (Stage 3 — deliberate temporary dual-path state):
 *   - BUIDL  → rwa.xyz multi-chain path (fetchTransfersRWA), one classify per
 *              (product, network) over all its observable networks.
 *   - others → existing Etherscan path (fetchTransferHistory), Ethereum only.
 *
 * Resumable: completed units are recorded in .cache/classify-progress.json,
 * keyed by slug for the Etherscan funds and by `slug:network` for BUIDL's
 * per-chain units. Restart after a failure — it picks up where it left off as
 * long as the progress file is < 12 hours old.
 *
 * ── Required Supabase tables ──────────────────────────────────────────────
 *
 * CREATE TABLE holder_classifications (
 *   product_slug       text NOT NULL,
 *   network            text NOT NULL DEFAULT 'ethereum',
 *   address            text NOT NULL,
 *   behavior           text NOT NULL,   -- Accumulating | Distributing | Dormant | Active
 *   balance_raw        text NOT NULL,
 *   inflow_raw         text NOT NULL DEFAULT '0',
 *   outflow_raw        text NOT NULL DEFAULT '0',
 *   is_labeled_custodian boolean NOT NULL DEFAULT false,
 *   name_tag           text,
 *   classified_at      timestamptz NOT NULL,
 *   as_of_block        integer NOT NULL,
 *   PRIMARY KEY (product_slug, network, address)
 * );
 *
 * CREATE TABLE holder_aggregate_stats (
 *   product_slug             text NOT NULL,
 *   network                  text NOT NULL DEFAULT 'ethereum',
 *   holder_count             integer NOT NULL,
 *   behavior_accumulating    integer NOT NULL,
 *   behavior_distributing    integer NOT NULL,
 *   behavior_dormant         integer NOT NULL,
 *   behavior_active          integer NOT NULL,
 *   dormancy_share_pct       numeric NOT NULL,
 *   net_new_wallets_90d      integer NOT NULL,
 *   exited_wallets_90d       integer NOT NULL,
 *   net_accumulation_ratio   numeric,
 *   classified_at            timestamptz NOT NULL,
 *   as_of_block              integer NOT NULL,
 *   PRIMARY KEY (product_slug, network)
 * );
 *
 * CREATE TABLE behavior_history (         -- append-only behavior log over time
 *   product_slug          text        NOT NULL,
 *   network               text        NOT NULL DEFAULT 'ethereum',
 *   dormancy_share_pct    numeric     NOT NULL,
 *   holder_count          integer     NOT NULL,
 *   behavior_accumulating integer     NOT NULL,
 *   behavior_distributing integer     NOT NULL,
 *   behavior_dormant      integer     NOT NULL,
 *   behavior_active       integer     NOT NULL,
 *   recorded_at           timestamptz NOT NULL DEFAULT now(),
 *   PRIMARY KEY (product_slug, network, recorded_at)
 * );  -- see supabase/migrations/20260616024608_create_behavior_history.sql
 *
 * Disable RLS on all tables (or grant INSERT/UPDATE to the anon role) if
 * you do not have a SUPABASE_SERVICE_ROLE_KEY in .env.local.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import fs from 'fs'
import path from 'path'
import { ACTIVE_PRODUCTS, getNavUsd } from '@/src/config/products'
import type { Product } from '@/src/config/products'
import { isCaseSensitive } from '@/src/config/networks'
import { fetchTransferHistory } from '@/src/lib/etherscan/transfers'
import { etherscanGet } from '@/src/lib/etherscan/client'
import { diskCacheRead, diskCacheWrite } from '@/src/lib/cache/disk'
import { KNOWN_ADDRESSES } from '@/src/lib/etherscan/nameTags'
import type { ContractSource, ERC20Transfer } from '@/src/lib/etherscan/types'
import {
  classifyHolders,
  computeAggregateStats,
  computeAggregateStatsFromState,
} from '@/src/lib/classify/engine'
import type { HolderClassification } from '@/src/lib/classify/types'
import { getSupabase } from '@/src/lib/supabase/client'
import { makeSupabaseDeps, runIncrementalFetchMerge } from '@/src/lib/rwa/incremental'
import type { BalanceStateMap, IncrementalDeps } from '@/src/lib/rwa/incremental'
import { fetchAssetSupplyByToken, sumSupplyForNetwork } from '@/src/lib/rwa/assets'
import type { TokenSupply } from '@/src/lib/rwa/assets'

// ── Constants ──────────────────────────────────────────────────────────────

const PROGRESS_FILE = path.join(process.cwd(), '.cache', 'classify-progress.json')
const PROGRESS_TTL_MS = 7 * 24 * 60 * 60 * 1000
const UPSERT_BATCH = 500

// Funds routed through the rwa.xyz multi-chain incremental path (per-network,
// cursor-based) instead of the Etherscan single-chain path. Migrating funds onto
// this set one at a time as their per-network config (decimals, address casing)
// is verified — see classifyRwaMultiChain.
const RWA_MULTICHAIN_SLUGS = new Set(['buidl', 'ustb', 'usyc'])

const CUSTODIAN_KEYWORDS = [
  'coinbase', 'binance', 'exchange', 'custodian', 'custody',
  'gnosis safe', 'multisig', 'vault', 'treasury', 'kraken',
  'gemini', 'bitfinex', 'okx', 'bybit', 'huobi',
]

// ── Progress tracking ──────────────────────────────────────────────────────

interface Progress {
  startedAt: string
  completedProducts: string[]
}

function loadProgress(): Progress | null {
  try {
    const raw = fs.readFileSync(PROGRESS_FILE, 'utf-8')
    const p: Progress = JSON.parse(raw)
    if (Date.now() - new Date(p.startedAt).getTime() > PROGRESS_TTL_MS) return null
    return p
  } catch {
    return null
  }
}

function saveProgress(p: Progress): void {
  try {
    fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true })
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[classify] could not write progress file:', err)
  }
}

// ── Name tag resolution (script-compatible, disk-cached) ──────────────────

function isCustodianTag(nameTag: string | null): boolean {
  if (!nameTag) return false
  const lower = nameTag.toLowerCase()
  return CUSTODIAN_KEYWORDS.some((kw) => lower.includes(kw))
}

async function resolveNameTag(
  address: string
): Promise<{ nameTag: string | null; isCustodian: boolean }> {
  const lower = address.toLowerCase()

  if (KNOWN_ADDRESSES[lower]) {
    const nameTag = KNOWN_ADDRESSES[lower]
    return { nameTag, isCustodian: isCustodianTag(nameTag) }
  }

  const cacheKey = `nametag-${lower}`
  const cached = diskCacheRead<string | null>(cacheKey, 24 * 60 * 60 * 1000)
  if (cached !== null) {
    return { nameTag: cached.data, isCustodian: isCustodianTag(cached.data) }
  }

  const sources = await etherscanGet<ContractSource[]>({
    module: 'contract',
    action: 'getsourcecode',
    address,
  })

  const contractName = sources?.[0]?.ContractName?.trim() || null
  diskCacheWrite(cacheKey, { fetchedAt: Date.now(), lastBlock: 0, data: contractName })

  return { nameTag: contractName, isCustodian: isCustodianTag(contractName) }
}

/** Resolve name tags for a batch of addresses, logging progress. */
async function resolveNameTags(
  addresses: string[]
): Promise<Map<string, { nameTag: string | null; isCustodian: boolean }>> {
  const result = new Map<string, { nameTag: string | null; isCustodian: boolean }>()
  for (let i = 0; i < addresses.length; i++) {
    if (i > 0 && i % 50 === 0) {
      console.log(`  name tags: ${i}/${addresses.length}`)
    }
    const r = await resolveNameTag(addresses[i])
    result.set(addresses[i].toLowerCase(), r)
  }
  return result
}

// ── Supabase writes ────────────────────────────────────────────────────────

async function upsertClassifications(
  productSlug: string,
  classifications: Map<string, HolderClassification>,
  asOfBlock: number,
  network: string
): Promise<void> {
  const supabase = getSupabase()
  const classifiedAt = new Date().toISOString()

  const rows = Array.from(classifications.values()).map((c) => ({
    product_slug: productSlug,
    network,
    address: c.address,
    behavior: c.behavior,
    balance_raw: c.balanceRaw,
    inflow_raw: c.inflowRaw,
    outflow_raw: c.outflowRaw,
    is_labeled_custodian: c.isLabeledCustodian,
    name_tag: c.nameTag,
    classified_at: classifiedAt,
    as_of_block: asOfBlock,
  }))

  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH)
    const { error } = await supabase
      .from('holder_classifications')
      .upsert(batch, { onConflict: 'product_slug,network,address' })
    if (error) throw new Error(`Supabase upsert failed (${productSlug}/${network} batch ${i}): ${error.message}`)
    console.log(`  wrote ${i + batch.length}/${rows.length} rows`)
  }

  // Remove stale rows: addresses that existed in a previous run but are no
  // longer current holders (zero balance today). Identified by classified_at
  // predating this run's timestamp. Scoped to (product_slug, network) so a run
  // for one network never deletes another network's rows.
  const { error: deleteError } = await supabase
    .from('holder_classifications')
    .delete()
    .eq('product_slug', productSlug)
    .eq('network', network)
    .lt('classified_at', classifiedAt)
  if (deleteError) throw new Error(`Supabase stale-row delete failed (${productSlug}/${network}): ${deleteError.message}`)
}

async function upsertAggregateStats(stats: ReturnType<typeof computeAggregateStats> & {
  productSlug: string
  asOfBlock: number
}, network: string, marketValueUsd: number | null = null): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase.from('holder_aggregate_stats').upsert({
    product_slug: stats.productSlug,
    network,
    holder_count: stats.holderCount,
    behavior_accumulating: stats.mix.accumulating,
    behavior_distributing: stats.mix.distributing,
    behavior_dormant: stats.mix.dormant,
    behavior_active: stats.mix.active,
    dormancy_share_pct: stats.dormancySharePct,
    net_new_wallets_90d: stats.netNewWallets90d,
    exited_wallets_90d: stats.exitedWallets90d,
    net_accumulation_ratio: stats.netAccumulationRatio ?? null,
    classified_at: new Date().toISOString(),
    as_of_block: stats.asOfBlock,
    // Omit-on-null: only write market_value_usd when a fresh value was captured, so
    // a transient market-value fetch failure never blanks a previously-good value
    // (PostgREST upsert leaves payload-absent columns untouched on conflict).
    ...(marketValueUsd != null ? { market_value_usd: marketValueUsd } : {}),
  }, { onConflict: 'product_slug,network' })
  if (error) throw new Error(`Supabase upsert failed (aggregate ${stats.productSlug}/${network}): ${error.message}`)
}

// Append one row to behavior_history per fund per run. Unlike the aggregate
// upsert above, this is an INSERT (not an upsert): every run accumulates a new
// row so holder-behavior metrics build a time series instead of being
// overwritten. recorded_at is filled by the column's now() default.
async function insertBehaviorHistory(stats: ReturnType<typeof computeAggregateStats> & {
  productSlug: string
}, network: string): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase.from('behavior_history').insert({
    product_slug: stats.productSlug,
    network,
    dormancy_share_pct: stats.dormancySharePct,
    holder_count: stats.holderCount,
    behavior_accumulating: stats.mix.accumulating,
    behavior_distributing: stats.mix.distributing,
    behavior_dormant: stats.mix.dormant,
    behavior_active: stats.mix.active,
  })
  if (error) throw new Error(`Supabase insert failed (behavior_history ${stats.productSlug}/${network}): ${error.message}`)
}

// ── Classify + write (shared by both fetch paths) ───────────────────────────

/**
 * Name-tag enrich (Ethereum-only gating) + write per-wallet classifications,
 * aggregate stats, and a behavior_history row. Shared tail for both fetch
 * paths: callers arrive with classifications + aggStats already computed —
 * from full history (Etherscan) or from merged incremental state (rwa.xyz).
 */
async function enrichAndWriteClassifications(
  product: Product,
  classifications: Map<string, HolderClassification>,
  aggStats: ReturnType<typeof computeAggregateStats>,
  network: string,
  asOfBlock: number,
  marketValueUsd: number | null = null,
  // Re-anchor is a REPAIR, not an observation — it re-derives current state and
  // must NOT append a behavior_history point (the next nightly writes that day's
  // observation from the repaired state). Default true = normal nightly behavior.
  writeBehaviorHistory = true
): Promise<void> {
  const { mix, dormancySharePct } = aggStats
  console.log(
    `  ${classifications.size} holders  dormancyShare=${dormancySharePct.toFixed(1)}%  ` +
    `mix: A=${mix.accumulating} D=${mix.distributing} Dormant=${mix.dormant} Active=${mix.active}`
  )

  // Resolve name tags for all holder addresses. Name tags come from Etherscan's
  // getsourcecode and are meaningless off Ethereum, so skip non-EVM networks and
  // leave name_tag null / isLabeledCustodian false (the classifyHolders default).
  if (network === 'ethereum') {
    console.log(`  resolving name tags for ${classifications.size} addresses…`)
    const addresses = Array.from(classifications.keys())
    const tags = await resolveNameTags(addresses)

    // Enrich classifications with name tag data
    for (const [addr, c] of classifications) {
      const tag = tags.get(addr.toLowerCase())
      if (tag) {
        c.nameTag = tag.nameTag
        c.isLabeledCustodian = tag.isCustodian
      }
    }

    const custodianCount = Array.from(classifications.values()).filter(
      (c) => c.isLabeledCustodian
    ).length
    if (custodianCount > 0) {
      console.log(`  labeled custodians: ${custodianCount}`)
    }
  } else {
    console.log(`  skipping name tags (network=${network}, non-EVM)`)
  }

  console.log(`  writing ${classifications.size} rows to Supabase…`)
  await upsertClassifications(product.slug, classifications, asOfBlock, network)

  // Also write aggregate stats so the dashboard can read from Supabase
  // without replaying the full transfer history on every request.
  console.log(`  writing aggregate stats to Supabase…`)
  await upsertAggregateStats({ ...aggStats, productSlug: product.slug, asOfBlock }, network, marketValueUsd)
  if (writeBehaviorHistory) {
    await insertBehaviorHistory({ ...aggStats, productSlug: product.slug }, network)
  } else {
    console.log(`  skipping behavior_history append (re-anchor is a repair, not an observation)`)
  }
}

/**
 * Classify a single (product, network) from full transfer history (Etherscan
 * path). Unchanged behavior — computes from the supplied transfers, then writes
 * via the shared enrich-and-write tail.
 */
async function classifyAndWritePerWallet(
  product: Product,
  transfers: ERC20Transfer[],
  network: string,
  asOfBlock: number,
  nowTs: number
): Promise<void> {
  console.log(`  classifying holders…`)
  const classifications = classifyHolders(transfers, nowTs)
  const aggStats = computeAggregateStats(transfers, nowTs)
  await enrichAndWriteClassifications(product, classifications, aggStats, network, asOfBlock)
}

// ── rwa.xyz multi-chain path (BUIDL) ────────────────────────────────────────

/**
 * Group a product's configured tokens by network, dropping any token that is
 * not behaviorally observable. Multiple contracts on one network (e.g. USDY's
 * native + Certificate) are merged so all their addresses fetch as one unit.
 */
function observableNetworks(
  product: Product
): Array<{ networkId: number; networkSlug: string; addresses: string[]; caseSensitive: boolean; decimals: number }> {
  const byNetwork = new Map<number, { networkSlug: string; addresses: string[]; decimals: number }>()
  for (const token of product.tokens ?? []) {
    if (!token.behaviorallyObservable) continue
    // Per-token decimals, falling back to the fund-level value when omitted.
    const decimals = token.decimals ?? product.decimals
    const existing = byNetwork.get(token.networkId)
    if (existing) {
      // Multiple contracts on one network (e.g. USDY's two ETH tokens) must share
      // decimals — throw rather than silently pick one if they disagree.
      if (existing.decimals !== decimals) {
        throw new Error(
          `[${product.slug}] conflicting decimals on network ${token.networkId}: ` +
          `${existing.decimals} vs ${decimals} — all tokens on a network must agree`
        )
      }
      existing.addresses.push(token.address)
    } else {
      byNetwork.set(token.networkId, { networkSlug: token.networkSlug, addresses: [token.address], decimals })
    }
  }
  return Array.from(byNetwork, ([networkId, v]) => ({
    networkId,
    networkSlug: v.networkSlug,
    addresses: v.addresses,
    // Chain-encoding case-sensitivity (base58/base32 ⇒ preserve case). Sourced
    // once per network from the registry, not per-token.
    caseSensitive: isCaseSensitive(networkId),
    decimals: v.decimals,
  }))
}

/** Deviation above which the state/aggregate mismatch is reported. */
const RECONCILE_WARN_PCT = 5
/**
 * Notional floor for the deviation check. Dust deployments (USYC Solana is ~$94
 * of supply) swing wildly in percentage terms on rounding alone, so a percentage
 * gate there is pure noise. Below the floor the check is skipped — but the skip
 * is logged, never silent.
 */
const RECONCILE_MIN_NOTIONAL_USD = 1_000_000

/** Exact bigint→token conversion; Number(raw) alone loses precision past 2^53. */
function toTokens(raw: bigint, decimals: number): number {
  const scale = BigInt(10) ** BigInt(decimals)
  return Number(raw / scale) + Number(raw % scale) / Number(scale)
}

/**
 * Reconciliation tripwire — compares the merged holder state against the
 * independent /v4/assets aggregate, and flags impossible balances.
 *
 * Two independent signals:
 *  • |Σ positive − aggregate supply| / supply > 5% ⇒ the holder state disagrees
 *    with the chain-indexed supply, so the metrics derived from it are suspect.
 *  • any negative balance ⇒ unconditional. A wallet cannot hold less than zero
 *    on-chain; a negative means transfers landed on mismatched address keys
 *    (the Solana ATA/owner split does exactly this).
 *
 * Warn-only by design — the caller has already sourced a sound weight.
 */
function reconcileState(
  productSlug: string,
  networkSlug: string,
  decimals: number,
  positive: BalanceStateMap,
  merged: BalanceStateMap,
  aggregateSupplyTokens: number | null,
  navUsd: number
): void {
  const tag = `${productSlug}:${networkSlug}`

  let positiveRaw = BigInt(0)
  for (const s of positive.values()) positiveRaw += s.balance
  const positiveTokens = toTokens(positiveRaw, decimals)

  if (aggregateSupplyTokens == null) {
    console.warn(`  TRIPWIRE ${tag}: skipped — no aggregate supply to reconcile against`)
  } else if (aggregateSupplyTokens <= 0) {
    console.warn(
      `  TRIPWIRE ${tag}: skipped — aggregate supply is ${aggregateSupplyTokens}, ` +
      `state holds ${positiveTokens.toLocaleString()} tokens`
    )
  } else {
    const notionalUsd = aggregateSupplyTokens * navUsd
    const deviation = Math.abs(positiveTokens - aggregateSupplyTokens) / aggregateSupplyTokens
    const pct = (deviation * 100).toFixed(2)
    if (notionalUsd < RECONCILE_MIN_NOTIONAL_USD) {
      console.log(
        `  tripwire ${tag}: skipped — notional $${Math.round(notionalUsd).toLocaleString()} ` +
        `below $${RECONCILE_MIN_NOTIONAL_USD.toLocaleString()} floor (deviation would be ${pct}%)`
      )
    } else if (deviation * 100 > RECONCILE_WARN_PCT) {
      console.warn(
        `  ⚠️  TRIPWIRE ${tag}: holder state disagrees with /v4/assets supply by ${pct}% ` +
        `(threshold ${RECONCILE_WARN_PCT}%)\n` +
        `      Σ positive balances : ${positiveTokens.toLocaleString()} tokens\n` +
        `      /v4/assets supply   : ${aggregateSupplyTokens.toLocaleString()} tokens\n` +
        `      ratio state/supply  : ${(positiveTokens / aggregateSupplyTokens).toFixed(4)}×\n` +
        `      market value weight is unaffected (sourced from /v4/assets), but holder_count, ` +
        `dormancy and concentration for this network derive from the state and are suspect.`
      )
    } else {
      console.log(`  tripwire ${tag}: state within ${pct}% of /v4/assets supply ✓`)
    }
  }

  // Negative balances — unconditional, no threshold, no notional floor.
  const negatives = Array.from(merged.entries()).filter(([, s]) => s.balance < BigInt(0))
  if (negatives.length > 0) {
    console.warn(
      `  ⚠️  TRIPWIRE ${tag}: ${negatives.length} NEGATIVE balance(s) in state — impossible on-chain, ` +
      `indicates transfers keyed to mismatched addresses:`
    )
    for (const [address, s] of negatives) {
      console.warn(`      ${address} = ${toTokens(s.balance, decimals).toLocaleString()} tokens`)
    }
  }
}

/**
 * Classify one (product, network) via the INCREMENTAL fetch-merge path:
 *   cursor + persisted balances (paginated read) → incremental gte pull +
 *   boundary dedup → merge → bounded 90d window pull for behavior → classify via
 *   the FromState cores → atomic RPC write-back of balances + cursor.
 *
 * First run (no cursor) is a full backfill — it still does the one-time deep
 * full-history pull. Every later run resumes from the cursor and pulls only new
 * transactions plus the bounded window, so it avoids the deep pagination that
 * was timing out CI. Balances + cursor advance atomically (apply_incremental_merge
 * RPC); the per-wallet classifications / aggregate stats are written by the
 * shared tail and are idempotently re-derived from state on any retry.
 *
 * @param supplyByToken per-fund /v4/assets supply map (see classifyRwaMultiChain);
 *                      null when that fetch failed, which omits the market value.
 */
async function classifyRwaNetworkIncremental(
  product: Product,
  net: { networkId: number; networkSlug: string; addresses: string[]; caseSensitive: boolean; decimals: number },
  nowTs: number,
  supplyByToken: Map<string, TokenSupply> | null
): Promise<void> {
  const deps = await makeSupabaseDeps({
    assetId: product.rwaAssetId!,
    networkId: net.networkId,
    decimals: net.decimals,
    tokenAddresses: net.addresses,
    caseSensitive: net.caseSensitive,
  })

  const res = await runIncrementalFetchMerge(
    { productSlug: product.slug, network: net.networkSlug, mode: 'per-wallet', nowTs, caseSensitive: net.caseSensitive },
    deps
  )
  console.log(
    `  fetched ${res.fetchedCount} (dedup-dropped ${res.dedupedBoundaryCount} boundary, ${res.newCount} new), ` +
    `persisted ${res.merged.size} balance rows, cursor → ${res.newCursor?.lastTxTimestamp ?? '(unchanged)'}` +
    ` (+${res.newCursor?.boundaryIds.length ?? 0} boundary id(s))`
  )

  // Per-network USD market value (supply weight for cross-chain supply-weighted
  // dormancy, read-layer Phase 2a): sourced from the /v4/assets per-network
  // aggregate × NAV.
  //
  // It is NOT self-computed from the merged positive balances any more. That
  // sum derives from /v4/transactions, which on Solana emits every transfer
  // through two parallel feeds — one keyed by associated token account, one by
  // owner wallet — with asymmetric mint/burn coverage, so positions double-count
  // and orphaned mints never net out. /v4/assets is independently chain-indexed
  // and immune to that. See src/lib/rwa/assets.ts for the full rationale.
  const nav = getNavUsd(product)
  const { supplyTokens, missing } = supplyByToken
    ? sumSupplyForNetwork(supplyByToken, net.addresses, net.decimals, `${product.slug}:${net.networkSlug}`)
    : { supplyTokens: null, missing: net.addresses }

  let marketValueUsd: number | null = null
  if (supplyTokens == null) {
    // Explicit and named — a silent null here would blank dormancy for the whole
    // fund downstream (Σ(dormancy × mv) needs every network's weight present).
    console.error(
      `  ERROR: no /v4/assets supply for ${product.slug}:${net.networkSlug} ` +
      `(token(s) ${missing.join(', ')}) — market value omitted, fund dormancy will be null`
    )
  } else {
    marketValueUsd = supplyTokens * nav
    console.log(
      `  market value (network ${net.networkSlug}): $${marketValueUsd.toLocaleString()}` +
      ` (${supplyTokens.toLocaleString()} tokens × $${nav} NAV, source: /v4/assets)`
    )
    if (missing.length > 0) {
      console.warn(
        `  WARNING: ${product.slug}:${net.networkSlug} — no /v4/assets entry for ` +
        `${missing.length} configured token(s): ${missing.join(', ')}; weight covers the rest only`
      )
    }
  }

  // Reconciliation tripwire. Σ(positive balances) is no longer the weight, but it
  // is still the state every OTHER metric (holder_count, dormancy, concentration)
  // is computed from — so its divergence from the independent aggregate is a
  // direct corruption signal for those metrics. Warn-only: the weight is sound
  // regardless, and failing the run would block the good networks too.
  reconcileState(product.slug, net.networkSlug, net.decimals, res.positive, res.merged, supplyTokens, nav)

  // Both outputs derive from the same merged state + window the orchestrator used.
  const classifications = res.classifications!
  const aggStats = computeAggregateStatsFromState(res.positive, res.windowTransfers, nowTs, net.caseSensitive)
  await enrichAndWriteClassifications(product, classifications, aggStats, net.networkSlug, 0, marketValueUsd)
}

/**
 * Classify a product across all its observable networks via rwa.xyz, treating
 * each (product, network) as one unit, through the incremental fetch-merge path.
 * Resumable per network via a `slug:network` progress key. rwa.xyz transfers
 * have no block number, so as_of_block is stored as 0 (unused in classify math).
 */
async function classifyRwaMultiChain(
  product: Product,
  progress: Progress,
  nowTs: number
): Promise<void> {
  if (product.rwaAssetId == null) {
    throw new Error(`[${product.slug}] missing rwaAssetId — required for the rwa.xyz multi-chain path`)
  }

  const networks = observableNetworks(product)
  console.log(`\n[${product.slug}] multi-chain via rwa.xyz (incremental) — ${networks.length} observable network(s)`)

  // ONE /v4/assets read per fund, threaded through the per-network loop below —
  // the endpoint returns every network's token in a single response, so fetching
  // per network would be N redundant requests. A failure here is non-fatal: the
  // run continues and each network reports its own missing-supply error, rather
  // than losing the whole fund's classification over a weight lookup.
  let supplyByToken: Map<string, TokenSupply> | null = null
  try {
    supplyByToken = await fetchAssetSupplyByToken(product.rwaAssetId)
    console.log(`  /v4/assets: supply for ${supplyByToken.size} token(s)`)
  } catch (err) {
    console.error(
      `  ERROR: /v4/assets fetch failed for ${product.slug} — market values omitted this run: ` +
      `${(err as Error).message}`
    )
  }

  for (const net of networks) {
    const key = `${product.slug}:${net.networkSlug}`
    if (progress.completedProducts.includes(key)) {
      console.log(`\n[${key}] skipping (already done this run)`)
      continue
    }

    console.log(`\n[${key}] incremental fetch-merge via rwa.xyz (${net.addresses.length} contract(s))…`)
    await classifyRwaNetworkIncremental(product, net, nowTs, supplyByToken)

    progress.completedProducts.push(key)
    saveProgress(progress)
    console.log(`[${key}] done ✓`)
  }
}

// ── Re-anchor (periodic full-history rebuild) ───────────────────────────────
// Repairs STATE DRIFT — corruption that lives only in accumulated persisted state
// (e.g. the case-fold class), not in the source. Per-network: full rebuild from
// epoch → supply-reconciliation gate → atomic replace-swap. Does NOT fix
// source-side corruption (reproduces identically) — see
// _local/periodic-reanchor-design.md.

/** Tolerance on the gate: swap only if candidate deviation ≤ current + ε.
 *  0.5% absorbs float noise without letting a materially-worse candidate through.
 *  (design doc open question "ε" — revisit against real per-network spreads.) */
const REANCHOR_EPSILON = 0.005

/** Σ positive balances of a state map, in whole tokens. */
function sumPositiveTokens(map: BalanceStateMap, decimals: number): number {
  let raw = BigInt(0)
  for (const s of map.values()) if (s.balance > BigInt(0)) raw += s.balance
  return toTokens(raw, decimals)
}

/**
 * Re-anchor one (product, network): rebuild candidate state from epoch, gate it
 * against the independent /v4/assets supply, and atomically replace stored state
 * ONLY if the candidate is no worse than what's already there. Warn-only on skip
 * — a blocked swap always leaves prior good state intact.
 */
async function reanchorRwaNetwork(
  product: Product,
  net: { networkId: number; networkSlug: string; addresses: string[]; caseSensitive: boolean; decimals: number },
  nowTs: number,
  supplyByToken: Map<string, TokenSupply> | null
): Promise<void> {
  const tag = `${product.slug}:${net.networkSlug}`
  const nav = getNavUsd(product)

  // Degenerate-reference guard (design Q1): never gate against null/zero supply —
  // a zero denominator makes the deviation meaningless. Skip the night, log why.
  const { supplyTokens: aggSupply, missing } = supplyByToken
    ? sumSupplyForNetwork(supplyByToken, net.addresses, net.decimals, tag)
    : { supplyTokens: null, missing: net.addresses }
  if (aggSupply == null || aggSupply <= 0) {
    console.warn(
      `  ⏭  ${tag}: SKIPPED — /v4/assets supply is ${aggSupply == null ? 'null' : aggSupply} ` +
      `(degenerate reference; token(s) ${missing.join(', ')}). Re-anchor needs a valid supply to gate against.`
    )
    return
  }
  if (missing.length > 0) {
    console.warn(`  ${tag}: gating against PARTIAL supply — no /v4/assets entry for ${missing.join(', ')}`)
  }

  const deps = await makeSupabaseDeps({
    assetId: product.rwaAssetId!,
    networkId: net.networkId,
    decimals: net.decimals,
    tokenAddresses: net.addresses,
    caseSensitive: net.caseSensitive,
  })
  if (!deps.reanchorSwap) {
    console.error(`  ERROR ${tag}: apply_reanchor_swap not wired (deps.reanchorSwap missing) — aborting network.`)
    return
  }

  // Current stored-state deviation (the thing we might replace).
  const currentState = await deps.loadState(product.slug, net.networkSlug)
  const currTokens = sumPositiveTokens(currentState, net.decimals)
  const currDev = Math.abs(currTokens - aggSupply) / aggSupply

  // Candidate: full rebuild from epoch. Force null cursor + empty state via a deps
  // wrapper, and skipWriteBack so nothing persists until the gate approves.
  const reanchorDeps: IncrementalDeps = {
    ...deps,
    loadCursor: async () => null,
    loadState: async () => new Map(),
  }
  console.log(`  ${tag}: rebuilding full history from epoch…`)
  const res = await runIncrementalFetchMerge(
    {
      productSlug: product.slug,
      network: net.networkSlug,
      mode: 'per-wallet',
      nowTs,
      caseSensitive: net.caseSensitive,
      skipWriteBack: true,
    },
    reanchorDeps
  )
  const candTokens = sumPositiveTokens(res.positive, net.decimals)
  const candDev = Math.abs(candTokens - aggSupply) / aggSupply

  console.log(
    `  ${tag}: gate — stored dev ${(currDev * 100).toFixed(2)}% (${currTokens.toLocaleString()} tok) ` +
    `vs candidate dev ${(candDev * 100).toFixed(2)}% (${candTokens.toLocaleString()} tok); ` +
    `supply ${aggSupply.toLocaleString()} tok`
  )

  // Gate: never replace better state with worse.
  if (candDev > currDev + REANCHOR_EPSILON) {
    console.warn(
      `  ⛔ ${tag}: SWAP BLOCKED — candidate (${(candDev * 100).toFixed(2)}%) worse than stored ` +
      `(${(currDev * 100).toFixed(2)}%) beyond ε ${(REANCHOR_EPSILON * 100).toFixed(1)}%. ` +
      `Likely a transient rwa.xyz gap — keeping current state.`
    )
    return
  }

  // Atomic replace-swap (apply_reanchor_swap): delete + insert candidate + move
  // cursor, one transaction. Prior state survives if this throws.
  await deps.reanchorSwap({
    productSlug: product.slug,
    network: net.networkSlug,
    merged: res.merged,
    newCursor: res.newCursor,
  })
  console.log(
    `  ✅ ${tag}: re-anchored (${res.merged.size} rows, cursor → ${res.newCursor?.lastTxTimestamp ?? '(reset)'})`
  )

  // Re-derive classifications/aggregate from the swapped state and write them.
  // Skip behavior_history (repair, not observation — design Q5). Weight from the
  // same /v4/assets supply used to gate.
  const marketValueUsd = aggSupply * nav
  const classifications = res.classifications!
  const aggStats = computeAggregateStatsFromState(res.positive, res.windowTransfers, nowTs, net.caseSensitive)
  await enrichAndWriteClassifications(product, classifications, aggStats, net.networkSlug, 0, marketValueUsd, false)

  // Tripwire on the freshly-swapped state (now clean, except any source-side
  // corruption that reproduces — expected no-op on Solana until B3).
  reconcileState(product.slug, net.networkSlug, net.decimals, res.positive, res.merged, aggSupply, nav)
}

/**
 * Re-anchor every observable network of one fund. One /v4/assets fetch (the gate's
 * reference) shared across networks; a fetch failure aborts the fund rather than
 * gating blind. Per-network errors are isolated so one bad network never blocks
 * the rest, and never touches stored state (the swap is all-or-nothing).
 */
async function reanchorRwaFund(product: Product, nowTs: number): Promise<void> {
  if (product.rwaAssetId == null) {
    throw new Error(`[${product.slug}] missing rwaAssetId — required for re-anchor`)
  }
  const networks = observableNetworks(product)
  console.log(`\n[${product.slug}] RE-ANCHOR (gated full-history rebuild) — ${networks.length} network(s)`)

  let supplyByToken: Map<string, TokenSupply>
  try {
    supplyByToken = await fetchAssetSupplyByToken(product.rwaAssetId)
    console.log(`  /v4/assets: supply for ${supplyByToken.size} token(s)`)
  } catch (err) {
    console.error(
      `  ABORT: /v4/assets fetch failed for ${product.slug} — cannot gate re-anchor without a supply ` +
      `reference; leaving all state intact: ${(err as Error).message}`
    )
    return
  }

  for (const net of networks) {
    try {
      await reanchorRwaNetwork(product, net, nowTs, supplyByToken)
    } catch (err) {
      console.error(
        `  ERROR ${product.slug}:${net.networkSlug} re-anchor failed — stored state intact: ${(err as Error).message}`
      )
    }
  }
  console.log(`[${product.slug}] re-anchor complete`)
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== classify ===')
  console.log(`window: trailing 90 days  |  ${new Date().toISOString()}`)

  const progress = loadProgress() ?? { startedAt: new Date().toISOString(), completedProducts: [] }
  if (progress.completedProducts.length > 0) {
    console.log(`resuming — already completed: ${progress.completedProducts.join(', ')}`)
  }

  const nowTs = Math.floor(Date.now() / 1000)

  // Re-anchor mode: REANCHOR=<fund> runs a gated full-history rebuild for ONE fund
  // and exits, instead of the normal incremental classify. Repairs state drift;
  // see _local/periodic-reanchor-design.md.
  const reanchorSlug = process.env.REANCHOR?.trim().toLowerCase()
  if (reanchorSlug) {
    console.log(`\n=== RE-ANCHOR mode: ${reanchorSlug} ===`)
    if (reanchorSlug === 'usdy') {
      console.error(
        `[usdy] re-anchor unsupported — its ~1.18M-row Solana history exceeds the all-or-nothing ` +
        `backfill (needs chunked backfill first). Aborting.`
      )
      return
    }
    if (!RWA_MULTICHAIN_SLUGS.has(reanchorSlug)) {
      console.error(
        `[${reanchorSlug}] re-anchor only applies to rwa.xyz multi-chain funds ` +
        `(${[...RWA_MULTICHAIN_SLUGS].join(', ')}). Aborting.`
      )
      return
    }
    const product = ACTIVE_PRODUCTS.find((p) => p.slug === reanchorSlug)
    if (!product) {
      console.error(`[${reanchorSlug}] not found in ACTIVE_PRODUCTS. Aborting.`)
      return
    }
    await reanchorRwaFund(product, nowTs)
    console.log('\n=== re-anchor done ===')
    return
  }

  // Optional scope filter: CLASSIFY_ONLY=buidl[,slug…] restricts the run to the
  // listed product slugs. Used to validate a single fund family in isolation
  // (e.g. the BUIDL incremental path) without re-running the others.
  const onlySlugs = process.env.CLASSIFY_ONLY?.split(',').map((s) => s.trim()).filter(Boolean)
  if (onlySlugs && onlySlugs.length > 0) {
    console.log(`scope: CLASSIFY_ONLY=${onlySlugs.join(',')}`)
  }

  for (const product of ACTIVE_PRODUCTS) {
    if (onlySlugs && onlySlugs.length > 0 && !onlySlugs.includes(product.slug)) continue

    // rwa.xyz multi-chain funds (BUIDL, USTB, USYC) → per-network incremental path. Each
    // manages its own per-network progress keys and writes, so handle and move on.
    // Funds not in the set stay on the existing Etherscan single-chain path below.
    if (RWA_MULTICHAIN_SLUGS.has(product.slug)) {
      await classifyRwaMultiChain(product, progress, nowTs)
      continue
    }

    if (progress.completedProducts.includes(product.slug)) {
      console.log(`\n[${product.slug}] skipping (already done this run)`)
      continue
    }

    console.log(`\n[${product.slug}] fetching transfer history…`)
    const transferData = await fetchTransferHistory(product, { pageSize: 10000 })
    const { transfers, lastBlock } = transferData
    console.log(`  ${transfers.length} transfers through block ${lastBlock} (fromCache=${transferData.fromCache})`)

    if (product.aggregateFlowsOnly) {
      // USDY — aggregate stats only
      console.log(`  computing aggregate stats…`)
      const stats = computeAggregateStats(transfers, nowTs)
      console.log(
        `  holders=${stats.holderCount}  dormancyShare=${stats.dormancySharePct.toFixed(1)}%  ` +
        `netNew=${stats.netNewWallets90d}  exited=${stats.exitedWallets90d}  ` +
        `mix: A=${stats.mix.accumulating} D=${stats.mix.distributing} Dormant=${stats.mix.dormant} Active=${stats.mix.active}`
      )
      console.log(`  writing aggregate stats to Supabase…`)
      await upsertAggregateStats({ ...stats, productSlug: product.slug, asOfBlock: lastBlock }, 'ethereum')
      await insertBehaviorHistory({ ...stats, productSlug: product.slug }, 'ethereum')
    } else {
      // Per-wallet classification (Etherscan path, Ethereum only)
      await classifyAndWritePerWallet(product, transfers, 'ethereum', lastBlock, nowTs)
    }

    progress.completedProducts.push(product.slug)
    saveProgress(progress)
    console.log(`[${product.slug}] done ✓`)
  }

  // Clear progress file on successful completion
  try { fs.unlinkSync(PROGRESS_FILE) } catch { /* already gone */ }
  console.log('\n=== classify complete ===')
}

main().catch((err) => {
  console.error('\n[classify] fatal error:', err)
  process.exit(1)
})
