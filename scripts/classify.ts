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
import { fetchTransferHistory, ETHERSCAN_MAX_PAGE_SIZE } from '@/src/lib/etherscan/transfers'
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
import { mergeTransfers, computeNewCursor, dedupBoundary } from '@/src/lib/rwa/incremental'
import type { BalanceStateMap, IncrementalDeps, FetchCursor, IncrementalResult } from '@/src/lib/rwa/incremental'
import type { MultiChainWriters } from '@/src/lib/rwa/multichain-write'
import { selectWriteMode, writePerWalletResult, writeAggregateResult } from '@/src/lib/rwa/multichain-write'
import type { RunBudget } from '@/src/lib/rwa/backfill-budget'
import { runSequentialUntilBudget } from '@/src/lib/rwa/backfill-budget'
import { fetchAssetSupplyByToken, sumSupplyForNetwork } from '@/src/lib/rwa/assets'
import type { TokenSupply } from '@/src/lib/rwa/assets'
import { fetchTransfersWindowRWA, fetchEarliestTxDate } from '@/src/lib/rwa/transfers'

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
 * Real (Supabase/Etherscan-backed) implementations of the multi-chain write
 * surface. The write tails + mode routing live in src/lib/rwa/multichain-write.ts
 * (importable/testable offline); this object wires them to the module-level
 * getSupabase writers and the Etherscan name-tag resolver.
 */
const realWriters: MultiChainWriters = {
  resolveNameTags,
  upsertClassifications,
  upsertAggregateStats,
  insertBehaviorHistory,
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
  await writePerWalletResult(realWriters, product, classifications, aggStats, network, asOfBlock)
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
 * Shared upstream of BOTH multi-chain write paths (per-wallet and aggregate):
 * derive the per-network USD market-value weight and run the reconciliation +
 * negative-balance tripwire against the just-merged state. Returns marketValueUsd
 * (null when supply is unavailable — logged, never thrown). Only the write TAIL
 * differs between the two paths; this weight+tripwire step is identical, so it
 * lives here rather than being duplicated per handler.
 *
 * Market value is sourced from the /v4/assets per-network aggregate × NAV, NOT
 * self-computed from merged positive balances: that sum derives from
 * /v4/transactions, which on Solana emits every transfer through two parallel
 * feeds (one keyed by associated token account, one by owner wallet) with
 * asymmetric mint/burn coverage, so positions double-count and orphaned mints
 * never net out. /v4/assets is independently chain-indexed and immune to that.
 * See src/lib/rwa/assets.ts for the full rationale.
 */
function computeMarketValueAndReconcile(
  product: Product,
  net: { networkId: number; networkSlug: string; addresses: string[]; caseSensitive: boolean; decimals: number },
  res: IncrementalResult,
  supplyByToken: Map<string, TokenSupply> | null
): number | null {
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

  return marketValueUsd
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

  // Per-network USD market-value weight + reconciliation tripwire — shared with
  // the aggregate path (see computeMarketValueAndReconcile for the sourcing note).
  const marketValueUsd = computeMarketValueAndReconcile(product, net, res, supplyByToken)

  // Both outputs derive from the same merged state + window the orchestrator used.
  const classifications = res.classifications!
  const aggStats = computeAggregateStatsFromState(res.positive, res.windowTransfers, nowTs, net.caseSensitive)
  await writePerWalletResult(realWriters, product, classifications, aggStats, net.networkSlug, 0, marketValueUsd)
}

/**
 * Classify one (product, network) via the AGGREGATE multi-chain path — the sibling
 * of classifyRwaNetworkIncremental for aggregateFlowsOnly funds (USDY). Everything
 * upstream is IDENTICAL and shared: fetch/merge/persist (balances + cursor still
 * written via apply_incremental_merge — needed for incremental resume and to source
 * the aggregate metrics), casing, decimals guard, ATA resolution, and the market
 * value + tripwire step. Only the WRITE TAIL differs:
 *   • runIncrementalFetchMerge runs in mode:'aggregate' — it returns res.aggregateStats
 *     (computed from state) and leaves res.classifications undefined.
 *   • Writes ONLY holder_aggregate_stats (with the market_value_usd weight) and a
 *     behavior_history row. NO per-wallet holder_classifications rows, NO name-tag
 *     resolution (no rows to tag), NO stale-delete against holder_classifications.
 * Mirrors the Etherscan aggregate branch in main() (computeAggregateStats →
 * upsertAggregateStats → insertBehaviorHistory), sourced from merged rwa state.
 */
async function classifyRwaNetworkAggregate(
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
    { productSlug: product.slug, network: net.networkSlug, mode: 'aggregate', nowTs, caseSensitive: net.caseSensitive },
    deps
  )
  console.log(
    `  fetched ${res.fetchedCount} (dedup-dropped ${res.dedupedBoundaryCount} boundary, ${res.newCount} new), ` +
    `persisted ${res.merged.size} balance rows, cursor → ${res.newCursor?.lastTxTimestamp ?? '(unchanged)'}` +
    ` (+${res.newCursor?.boundaryIds.length ?? 0} boundary id(s))`
  )

  const marketValueUsd = computeMarketValueAndReconcile(product, net, res, supplyByToken)

  // Aggregate write tail. res.aggregateStats is computed by runIncrementalFetchMerge
  // in aggregate mode (from the same positive state + window); classifications is
  // undefined here by design. writeAggregateResult does the two writes only — no
  // per-wallet rows, no name tags — see src/lib/rwa/multichain-write.ts.
  await writeAggregateResult(realWriters, product, res.aggregateStats!, net.networkSlug, marketValueUsd)
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

    // A network mid-chunked-backfill has INCOMPLETE state — the ordinary
    // incremental path would (a) derive metrics from partial state and (b) do one
    // unbounded forward pull, defeating the chunking. Skip it; the dedicated
    // backfill job advances it and flips the flag when it reaches the present.
    if (await isBackfillInProgress(product.slug, net.networkSlug)) {
      console.log(`\n[${key}] backfill in progress — skipping incremental (state incomplete)`)
      continue
    }

    console.log(`\n[${key}] incremental fetch-merge via rwa.xyz (${net.addresses.length} contract(s))…`)
    // Same fetch/merge/persist upstream; the write tail forks on the fund's mode
    // (selectWriteMode). aggregateFlowsOnly (USDY) → aggregate stats + behavior
    // only, no per-wallet rows. The backfill-in-progress guard above sits upstream
    // of BOTH forks, so a network with incomplete state is skipped identically.
    if (selectWriteMode(product) === 'aggregate') {
      await classifyRwaNetworkAggregate(product, net, nowTs, supplyByToken)
    } else {
      await classifyRwaNetworkIncremental(product, net, nowTs, supplyByToken)
    }

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
  await writePerWalletResult(realWriters, product, classifications, aggStats, net.networkSlug, 0, marketValueUsd, false)

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

// ── Chunked / resumable first-backfill ──────────────────────────────────────
// For networks too big to pull in one shot (USDY Solana ~1.18M txns / ~1,186
// pages, >10h of request budget at 120/hr). Runs the merge over successive
// day-bounded windows OLDEST→NEWEST, persisting balances+cursor after each window
// so it survives budget exhaustion / process death, and never derives metrics
// until it reaches the present. See _local/resumable-backfill-design.md.

/** Networks cleared for chunked backfill. The MECHANISM is general (any fund with
 *  rwa tokens[]), but networks are enabled explicitly as their config is verified —
 *  a network's per-token decimals must be set (fund-level fallback would mis-scale)
 *  and any anomaly resolved (e.g. MANTRA's decimals=1) BEFORE enabling. All 8 of
 *  USDY's INCLUDED networks are now vetted (per-token decimals set, probe-confirmed)
 *  and enabled; the excluded MANTRA/Noble/Sui stay out (see the tokens[] comments).
 *  Enabling all 8 at once is safe because the shared per-run page pool
 *  (BACKFILL_PER_RUN_PAGES, sequential-exhaust) caps a BACKFILL=all run at the same
 *  ~80 pages regardless of network count — one network drains the pool, the rest
 *  wait for the next 3-hourly slot, so it converges over ~2-3 days without ever
 *  blowing rwa.xyz's 120/hr. Deliberately independent of RWA_MULTICHAIN_SLUGS: USDY
 *  is not in that set yet (cutover is separately gated on all 8 having state +
 *  Ethereum parity), but backfill only builds STATE and never derives metrics, so
 *  state-building is safe to run ahead of the cutover. Slugs are the merged network
 *  slugs from observableNetworks — USDY's two Ethereum contracts share 'ethereum'. */
const BACKFILL_ALLOWED: Record<string, Set<string>> = {
  usdy: new Set(['ethereum', 'arbitrum', 'mantle', 'plume', 'sei', 'solana', 'aptos', 'stellar']),
}

/** Per-run request budget (pages) — a SINGLE shared pool drawn down across every
 *  in-progress (fund, network) in the run, not one budget per network. Stays under
 *  rwa.xyz's 120/hr with headroom for the nightly's ~10-15 requests if they land in
 *  the same rolling hour: even a worst-case backfill+nightly overlap (80 + ~15) sits
 *  under 120, and the shared pool means adding networks does NOT scale the spend —
 *  two networks share these 80 pages rather than spending 80 each. See
 *  src/lib/rwa/backfill-budget.ts for the sequential-exhaust allocation policy. */
const BACKFILL_PER_RUN_PAGES = 80
/** Adaptive window target: size each window toward ~this many pages. */
const BACKFILL_TARGET_PAGES = 40
const BACKFILL_MIN_SPAN_DAYS = 1
const BACKFILL_MAX_SPAN_DAYS = 60
const BACKFILL_INITIAL_SPAN_DAYS = 30

/** A rwa.xyz 429 surfaces as a thrown Error whose message carries `HTTP 429` (the
 *  http layer keeps its `… failed (page N): HTTP <status> — <body>` shape stable and
 *  does NOT retry 429s). A 429 is a global rate-limit signal, so the backfill uses it
 *  to end the whole run — not just the offending network. */
const isRateLimitError = (err: Error) => /HTTP 429\b/.test(err.message)

const clampSpan = (n: number) => Math.max(BACKFILL_MIN_SPAN_DAYS, Math.min(BACKFILL_MAX_SPAN_DAYS, n))
/** Unix seconds → 'YYYY-MM-DD' (UTC). */
const toDayStr = (unixSec: number) => new Date(unixSec * 1000).toISOString().slice(0, 10)
/** Add n days to a 'YYYY-MM-DD' day string (UTC). */
function addDaysStr(dayStr: string, n: number): string {
  const d = new Date(`${dayStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Backfill lifecycle of a (fund, network): no cursor row ⇒ never started. */
async function backfillStatus(slug: string, network: string): Promise<'fresh' | 'in_progress' | 'complete'> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('fetch_cursor')
    .select('backfill_complete')
    .eq('product_slug', slug)
    .eq('network', network)
    .maybeSingle()
  if (error) {
    // Column missing (migration not yet applied) or read error: treat as complete
    // so the nightly is never broken by this check pre-migration.
    console.warn(`  [backfill] status read failed for ${slug}:${network} (${error.message}) — treating as complete`)
    return 'complete'
  }
  if (!data) return 'fresh'
  return data.backfill_complete === false ? 'in_progress' : 'complete'
}

/** True only when a chunked backfill is actively mid-flight for this network. Used
 *  by the nightly to SKIP a network whose state is still incomplete. Defensive: any
 *  error (e.g. pre-migration) reports false, so the nightly behaves as before. */
async function isBackfillInProgress(slug: string, network: string): Promise<boolean> {
  return (await backfillStatus(slug, network)) === 'in_progress'
}

async function markBackfillInProgress(slug: string, network: string): Promise<void> {
  const supabase = getSupabase()
  // Upsert with ONLY backfill_complete=false: PostgREST leaves payload-absent
  // columns untouched on conflict, so an existing cursor's last_tx_timestamp /
  // boundary_tx_ids survive (resume-safe). A fresh row gets null cursor + false.
  const { error } = await supabase
    .from('fetch_cursor')
    .upsert({ product_slug: slug, network, backfill_complete: false }, { onConflict: 'product_slug,network' })
  if (error) throw new Error(`fetch_cursor backfill-in-progress mark failed (${slug}/${network}): ${error.message}`)
}

async function markBackfillComplete(slug: string, network: string): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase
    .from('fetch_cursor')
    .update({ backfill_complete: true })
    .eq('product_slug', slug)
    .eq('network', network)
  if (error) throw new Error(`fetch_cursor backfill-complete mark failed (${slug}/${network}): ${error.message}`)
}

/**
 * Backfill one (fund, network) by chunked windows until the per-run page budget is
 * spent or the network catches up to the present. Resumable: all durable progress
 * is in holder_balance_state + fetch_cursor, so a new run just resumes from the
 * cursor. Persists balances+cursor only — NO classification/aggregate/behavior
 * writes while incomplete (partial-state guard).
 */
async function backfillRwaNetwork(
  product: Product,
  net: { networkId: number; networkSlug: string; addresses: string[]; caseSensitive: boolean; decimals: number },
  nowTs: number,
  budget: RunBudget
): Promise<void> {
  const tag = `${product.slug}:${net.networkSlug}`

  const status = await backfillStatus(product.slug, net.networkSlug)
  if (status === 'complete') {
    console.log(`  ${tag}: backfill already complete — nothing to do`)
    return
  }

  // Sequential-exhaust: if the shared pool is already dry, do NOTHING here — no
  // in-progress mark, no state load — and leave this network for the next slot.
  // (A no-op window loop would still mark a fresh network in-progress with zero
  // rows, so gate before any side effect.)
  if (budget.remaining <= 0) {
    console.log(`  ${tag}: run page pool exhausted — deferring to next slot`)
    return
  }

  const deps = await makeSupabaseDeps({
    assetId: product.rwaAssetId!,
    networkId: net.networkId,
    decimals: net.decimals,
    tokenAddresses: net.addresses,
    caseSensitive: net.caseSensitive,
  })

  // Mark in-progress BEFORE the first persist so apply_incremental_merge preserves
  // the flag (its cursor upsert doesn't touch backfill_complete) and the nightly
  // skips this network. Idempotent for a resumed backfill.
  await markBackfillInProgress(product.slug, net.networkSlug)

  let cursor: FetchCursor | null = await deps.loadCursor(product.slug, net.networkSlug)
  let state = await deps.loadState(product.slug, net.networkSlug)
  const todayDay = toDayStr(nowTs)

  let frontierDay: string
  if (cursor) {
    frontierDay = cursor.lastTxTimestamp.slice(0, 10)
    console.log(`  ${tag}: resuming backfill from cursor ${cursor.lastTxTimestamp} (${status})`)
  } else {
    const earliest = await fetchEarliestTxDate(product.rwaAssetId!, net.networkId)
    if (earliest == null) {
      console.log(`  ${tag}: no transactions on this network — marking complete`)
      await markBackfillComplete(product.slug, net.networkSlug)
      return
    }
    frontierDay = earliest
    console.log(`  ${tag}: fresh backfill from earliest tx date ${earliest}`)
  }

  let spanDays = BACKFILL_INITIAL_SPAN_DAYS
  let pagesThisNetwork = 0

  // Draw from the SHARED run pool: this network keeps taking windows until the
  // pool (not a per-network budget) is dry or it catches up to the present.
  while (budget.remaining > 0) {
    if (frontierDay >= todayDay) {
      console.log(`  ${tag}: reached present (${frontierDay} ≥ ${todayDay}) — backfill COMPLETE`)
      await markBackfillComplete(product.slug, net.networkSlug)
      return
    }
    let windowEnd = addDaysStr(frontierDay, spanDays)
    if (windowEnd > todayDay) windowEnd = todayDay

    const { transfers, pages } = await fetchTransfersWindowRWA(
      product.rwaAssetId!, net.networkId, net.decimals, net.addresses, frontierDay, windowEnd
    )
    pagesThisNetwork += pages
    budget.remaining -= pages

    // Dedup the inclusive-gte boundary day already processed last window, merge,
    // and checkpoint. Windows are disjoint [start,end), so this only ever removes
    // the cursor-day overlap on a resume.
    const newTransfers = dedupBoundary(transfers, cursor?.boundaryIds ?? null)
    state = mergeTransfers(state, newTransfers, net.caseSensitive).merged

    const newCursor: FetchCursor = newTransfers.length > 0
      ? computeNewCursor(newTransfers, cursor)! // non-null: newTransfers non-empty
      // Empty window (gap) — advance the frontier past it so we don't re-scan the
      // same empty range forever. Synthetic cursor at windowEnd, no boundary ids.
      : { lastTxTimestamp: `${windowEnd}T00:00:00.000Z`, boundaryIds: [] }

    // Persist balances + cursor ONLY (apply_incremental_merge). No classifications /
    // aggregate / behavior writes — partial-state guard (state still incomplete).
    await deps.writeBack({ productSlug: product.slug, network: net.networkSlug, merged: state, newCursor })

    cursor = newCursor
    frontierDay = cursor.lastTxTimestamp.slice(0, 10)

    // Adaptive sizing: aim the next window at ~TARGET pages from observed density.
    // Empty windows carry no density signal, so grow (bounded) to skip sparse gaps.
    spanDays = pages > 0
      ? clampSpan(Math.round((BACKFILL_TARGET_PAGES * spanDays) / pages))
      : clampSpan(spanDays * 2)

    console.log(
      `  ${tag}: window [${frontierDay}…] done — ${pages}pg, ${newTransfers.length} new, ` +
      `${state.size} rows; next span ${spanDays}d; net pages ${pagesThisNetwork}; pool ${budget.remaining}/${BACKFILL_PER_RUN_PAGES} left`
    )
  }

  console.log(
    `  ${tag}: shared run pool exhausted (this network took ${pagesThisNetwork}pg) — resumes next run from ${cursor?.lastTxTimestamp}`
  )
  console.log(`  ${tag}: tripwire skipped — EXPECTED-partial (backfill in progress, state incomplete by design)`)
}

/** Backfill every enabled network of a fund, drawing from the shared run `budget`
 *  (sequential-exhaust, config order). Non-429 per-network errors are isolated; a
 *  429 drains the pool to end the run. Per-window atomicity means a failure never
 *  loses prior chunks. Cleanly no-ops when nothing is enabled or already complete. */
async function backfillRwaFund(product: Product, nowTs: number, budget: RunBudget): Promise<void> {
  if (product.rwaAssetId == null) {
    console.error(`[${product.slug}] no rwaAssetId — backfill needs rwa.xyz config. Skipping.`)
    return
  }
  const allowed = BACKFILL_ALLOWED[product.slug]
  if (!allowed || allowed.size === 0) {
    console.log(`[${product.slug}] not enabled for chunked backfill — clean no-op.`)
    return
  }
  const networks = observableNetworks(product).filter((net) => allowed.has(net.networkSlug))
  console.log(`\n[${product.slug}] BACKFILL (chunked, resumable) — enabled network(s): ${[...allowed].join(', ')}`)

  // Sequential-exhaust across this fund's networks (config order), all drawing
  // from the shared run pool; once it is dry, the remaining networks wait for the
  // next slot. Per-window atomicity means any failure never loses prior chunks, so
  // the run always ends gracefully with everything checkpointed. Error handling:
  //   • a 429 is a GLOBAL rate-limit signal — draining the pool to zero ends the
  //     whole run (this fund's remaining networks AND later funds share the pool),
  //     so we stop instead of hammering the API network-by-network while limited;
  //   • any other per-network error stays ISOLATED (log, next network continues),
  //     preserving the original "one bad network never aborts the fund" behaviour.
  await runSequentialUntilBudget(networks, budget, async (net) => {
    try {
      await backfillRwaNetwork(product, net, nowTs, budget)
    } catch (err) {
      const e = err as Error
      if (isRateLimitError(e)) {
        console.error(
          `  ${product.slug}:${net.networkSlug} hit rwa.xyz rate limit (429) — ending run gracefully; ` +
          `prior chunks checkpointed, resumes next slot: ${e.message}`
        )
        budget.remaining = 0 // stop all remaining networks/funds via the pool guard
      } else {
        console.error(
          `  ERROR ${product.slug}:${net.networkSlug} backfill window failed — prior chunks preserved ` +
          `(per-window atomic); resumes next run: ${e.message}`
        )
      }
    }
  })
  console.log(`[${product.slug}] backfill pass complete`)
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

  // Backfill mode: BACKFILL=<fund>|all runs the chunked resumable first-backfill for
  // the enabled networks and exits. `all` sweeps every fund in BACKFILL_ALLOWED; a
  // named fund does just that one. No-ops cleanly when nothing is in progress.
  const backfillArg = process.env.BACKFILL?.trim().toLowerCase()
  if (backfillArg) {
    console.log(`\n=== BACKFILL mode: ${backfillArg} ===`)
    const slugs = backfillArg === 'all' ? Object.keys(BACKFILL_ALLOWED) : [backfillArg]
    if (slugs.length === 0) {
      console.log('no funds enabled for backfill (BACKFILL_ALLOWED is empty) — clean no-op.')
    }
    // ONE shared page pool for the whole run, drawn down across every fund and
    // network in config order (sequential-exhaust). This — not a per-network
    // budget — is what keeps a multi-network run under rwa.xyz's 120/hr.
    const budget: RunBudget = { remaining: BACKFILL_PER_RUN_PAGES }
    const products = slugs
      .map((slug) => {
        const product = ACTIVE_PRODUCTS.find((p) => p.slug === slug)
        if (!product) console.error(`[${slug}] not found in ACTIVE_PRODUCTS. Skipping.`)
        return product
      })
      .filter((p): p is Product => p != null)
    await runSequentialUntilBudget(products, budget, (product) => backfillRwaFund(product, nowTs, budget))
    console.log(`\n=== backfill done (${BACKFILL_PER_RUN_PAGES - budget.remaining}/${BACKFILL_PER_RUN_PAGES} pool pages spent) ===`)
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
    // pageSize = the Etherscan free-tier per-page cap (1000): requesting more is
    // silently capped and would truncate to one page (the 07-16 regression).
    const transferData = await fetchTransferHistory(product, { pageSize: ETHERSCAN_MAX_PAGE_SIZE })
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
