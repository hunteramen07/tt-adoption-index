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
 * CREATE TABLE reconciliation_history ( -- append-only supply-tripwire log, one row
 *   ...                                 -- per (product, network) per run, skips included
 * );  -- see supabase/migrations/20260914120000_create_reconciliation_history.sql
 *     -- (applied by hand; a missing table downgrades to a warning, never fails a run)
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
import {
  BACKFILL_INITIAL_SPAN_DAYS,
  BACKFILL_TARGET_PAGES,
  clampSpan,
  nextSpanFromDensity,
  halveSpanOnFailure,
  sizeWindowByPreflight,
  syntheticAdvanceTarget,
  lagBandStart,
  BACKFILL_TRAILING_LAG_DAYS,
} from '@/src/lib/rwa/backfill-span'
import { fetchAssetSupplyByToken, sumSupplyForNetwork } from '@/src/lib/rwa/assets'
import { logRpcEndpointsInUse } from '@/src/lib/rwa/solana-rpc'
import type { TokenSupply } from '@/src/lib/rwa/assets'
import { fetchTransfersWindowRWA, fetchEarliestTxDate, countTransfersWindowPagesRWA } from '@/src/lib/rwa/transfers'
import { fetchChainSupply, toTokens } from '@/src/lib/rwa/chain-supply'
import type { ChainSupply } from '@/src/lib/rwa/chain-supply'
import {
  evaluateReconciliation,
  insertReconciliationHistory,
  isReconcileStrict,
  RECONCILE_WARN_PCT,
  RECONCILE_MIN_NOTIONAL_USD,
  decideBackfillCompletion,
} from '@/src/lib/rwa/reconciliation'
import type { ReconciliationHistoryRow } from '@/src/lib/rwa/reconciliation'

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

/**
 * Reconciliation tripwire — compares the merged holder state against ON-CHAIN
 * supply, and flags impossible balances. Every outcome is logged AND persisted to
 * reconciliation_history: a passing check that writes nothing and a failing one
 * that scrolls off a CI log are equally invisible a week later. The outcome set,
 * the 3% threshold, the $1M floor, and why the reference is chain rather than
 * /v4/assets all live in src/lib/rwa/reconciliation.ts.
 *
 * Two independent signals:
 *  • |Σ positive − chain supply| / chain supply > 3% ⇒ the holder state disagrees
 *    with the chain, so the metrics derived from it are suspect. Warn-only unless
 *    RECONCILE_STRICT=1, which throws: the caller has not yet written this
 *    network's classifications/aggregate, so a strict failure withholds suspect
 *    metrics from the dashboard while the already-persisted state+cursor resume
 *    normally next run.
 *  • any negative balance ⇒ unconditional, never strict-fatal. A wallet cannot hold
 *    less than zero on-chain; a negative means transfers landed on mismatched
 *    address keys, or an rwa.xyz source hole (the known residuals).
 *
 * A network with NO chain reference is SKIPPED — never checked against /v4/assets
 * instead. Plus one informational line, zero threshold: /v4/assets vs chain,
 * rwa.xyz's own indexing gap, independent of our state.
 */
async function reconcileState(
  productSlug: string,
  networkSlug: string,
  decimals: number,
  positive: BalanceStateMap,
  merged: BalanceStateMap,
  chain: ChainSupply | null,
  chainError: string | null,
  assetsSupplyTokens: number | null,
  navUsd: number,
  context: 'classify' | 'reanchor'
): Promise<void> {
  const tag = `${productSlug}:${networkSlug}`

  let positiveRaw = BigInt(0)
  for (const s of positive.values()) positiveRaw += s.balance
  const positiveTokens = toTokens(positiveRaw, decimals)
  const negatives = Array.from(merged.entries()).filter(([, s]) => s.balance < BigInt(0))

  const r = evaluateReconciliation({
    stateTokens: positiveTokens,
    holderCount: positive.size,
    negativeCount: negatives.length,
    chain,
    chainError,
    assetsSupplyTokens,
    navUsd,
  })
  const strict = isReconcileStrict()
  const pct = r.deviationPct == null ? null : r.deviationPct.toFixed(2)
  const ref = chain?.reference ?? 'chain'

  switch (r.outcome) {
    case 'skipped_no_reference':
      console.log(`  tripwire ${tag}: skipped — no chain reference for this network (not falling back to /v4/assets)`)
      break
    case 'skipped_reference_failed':
      console.warn(`  TRIPWIRE ${tag}: skipped — chain reference unavailable this run: ${chainError}`)
      break
    case 'skipped_degenerate':
      console.warn(
        `  TRIPWIRE ${tag}: skipped — chain supply is ${chain!.supplyTokens}, ` +
        `state holds ${positiveTokens.toLocaleString()} tokens`
      )
      break
    case 'skipped_dust':
      console.log(
        `  tripwire ${tag}: skipped — notional $${Math.round(r.notionalUsd!).toLocaleString()} ` +
        `below $${RECONCILE_MIN_NOTIONAL_USD.toLocaleString()} floor (deviation would be ${pct}%)`
      )
      break
    case 'warn':
      console.warn(
        `  ⚠️  TRIPWIRE ${tag}: holder state disagrees with on-chain supply by ${pct}% ` +
        `(threshold ${RECONCILE_WARN_PCT}%${strict ? ', STRICT' : ''})\n` +
        `      Σ positive balances : ${positiveTokens.toLocaleString()} tokens\n` +
        `      chain supply        : ${chain!.supplyTokens.toLocaleString()} tokens (${ref})\n` +
        `      ratio state/chain   : ${r.ratio!.toFixed(4)}×\n` +
        `      market value weight is unaffected (sourced from /v4/assets), but holder_count, ` +
        `dormancy and concentration for this network derive from the state and are suspect.`
      )
      break
    case 'pass':
      console.log(`  tripwire ${tag}: state within ${pct}% of on-chain supply ✓ (${ref})`)
      break
  }

  // Informational: rwa.xyz vs chain. Zero threshold, never changes the outcome —
  // this is the number the data-quality list in _local/STATUS.md is built from.
  if (chain && r.outcome !== 'skipped_degenerate') {
    if (r.assetsDeltaPct == null) {
      console.log(`  info ${tag}: /v4/assets unavailable — assets-vs-chain delta not computed`)
    } else {
      const sign = r.assetsDeltaPct >= 0 ? '+' : ''
      console.log(
        `  info ${tag}: /v4/assets ${assetsSupplyTokens!.toLocaleString()} vs chain ` +
        `${chain.supplyTokens.toLocaleString()} tokens → rwa.xyz ${sign}${r.assetsDeltaPct.toFixed(2)}% vs chain (informational)`
      )
    }
  }

  // Negative balances — unconditional, no threshold, no notional floor.
  if (negatives.length > 0) {
    console.warn(
      `  ⚠️  TRIPWIRE ${tag}: ${negatives.length} NEGATIVE balance(s) in state — impossible on-chain, ` +
      `indicates transfers keyed to mismatched addresses:`
    )
    for (const [address, s] of negatives) {
      console.warn(`      ${address} = ${toTokens(s.balance, decimals).toLocaleString()} tokens`)
    }
  }

  // Persist EVERY evaluation, skips included. Failure here is a warning, not an
  // abort: the table is applied by hand and may not exist yet.
  const row: ReconciliationHistoryRow = {
    product_slug: productSlug,
    network: networkSlug,
    context,
    outcome: r.outcome,
    reference: chain?.reference ?? null,
    state_tokens: positiveTokens,
    holder_count: positive.size,
    negative_count: negatives.length,
    chain_supply_tokens: chain?.supplyTokens ?? null,
    assets_supply_tokens: assetsSupplyTokens,
    deviation_pct: r.deviationPct,
    assets_delta_pct: r.assetsDeltaPct,
    notional_usd: r.notionalUsd,
    threshold_pct: r.thresholdPct,
    strict,
  }
  try {
    await insertReconciliationHistory(row)
  } catch (err) {
    console.warn(`  reconciliation_history write failed (${(err as Error).message}) — row not persisted`)
  }

  if (strict && r.outcome === 'warn') {
    throw new Error(
      `[${tag}] RECONCILE_STRICT=1: holder state deviates ${pct}% from on-chain supply ` +
      `(threshold ${RECONCILE_WARN_PCT}%) — withholding this network's metrics`
    )
  }
}

/**
 * Read the tripwire's on-chain reference for one network. A throw (RPC down,
 * decimals mismatch) becomes `chainError` and the tripwire records a
 * skipped_reference_failed row — it never substitutes /v4/assets for a reference
 * it could not read.
 */
async function readChainReference(
  product: Product,
  net: { networkId: number; addresses: string[]; decimals: number; networkSlug: string }
): Promise<{ chain: ChainSupply | null; chainError: string | null }> {
  try {
    const chain = await fetchChainSupply(net.networkId, net.addresses, net.decimals, `${product.slug}:${net.networkSlug}`)
    return { chain, chainError: null }
  } catch (err) {
    return { chain: null, chainError: (err as Error).message }
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
 * Two different references, deliberately:
 *  • The WEIGHT is /v4/assets × NAV — an aggregate figure, so it carries none of
 *    the per-position keying hazards a Σ(positive balances) would (the Solana
 *    dual-feed double-count), and it is the supply the dashboard already reports.
 *  • The TRIPWIRE reference is ON-CHAIN supply. /v4/assets is NOT independent of
 *    the state under test — both are served from rwa.xyz's ledger and agree to
 *    1e-6 on Solana — so checking state against it can only ever catch our own
 *    replay bugs, never rwa.xyz's indexing gaps. See src/lib/rwa/assets.ts and
 *    src/lib/rwa/chain-supply.ts.
 */
async function computeMarketValueAndReconcile(
  product: Product,
  net: { networkId: number; networkSlug: string; addresses: string[]; caseSensitive: boolean; decimals: number },
  res: IncrementalResult,
  supplyByToken: Map<string, TokenSupply> | null
): Promise<number | null> {
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
  // is computed from — so its divergence from the INDEPENDENT on-chain supply is a
  // direct corruption signal for those metrics. Warn-only by default: the weight
  // is sound regardless, and failing the run would block the good networks too
  // (RECONCILE_STRICT=1 opts into fail-fast for this network — see reconcileState).
  const { chain, chainError } = await readChainReference(product, net)
  await reconcileState(
    product.slug, net.networkSlug, net.decimals, res.positive, res.merged,
    chain, chainError, supplyTokens, nav, 'classify'
  )

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
  const marketValueUsd = await computeMarketValueAndReconcile(product, net, res, supplyByToken)

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

  const marketValueUsd = await computeMarketValueAndReconcile(product, net, res, supplyByToken)

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

  // Tripwire on the freshly-swapped state, against ON-CHAIN supply (the gate above
  // is a relative candidate-vs-stored comparison and stays on /v4/assets; this is
  // the absolute check). A rebuild reproduces any rwa.xyz source-side gap
  // identically, so a warn here after a clean swap is an rwa-vs-chain finding,
  // not a swap failure. Persisted with context 'reanchor'.
  const { chain, chainError } = await readChainReference(product, net)
  await reconcileState(
    product.slug, net.networkSlug, net.decimals, res.positive, res.merged,
    chain, chainError, aggSupply, nav, 'reanchor'
  )
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

/** Networks cleared for chunked backfill, in PRIORITY order (the order they draw from
 *  the shared pool within a run — NOT products.ts tokens[] order). FUNDS drain in this
 *  object's key order (Object.keys), so a small fund must be listed before a big one
 *  or it is starved behind it. Within a fund: smallest expected
 *  remaining work first, so a network needing a few pages is never starved for weeks
 *  behind one needing ~1,000: on 2026-09-15 the six re-opened USDY networks (~173
 *  pages total) sat behind usdy:solana (~983 pages, making zero progress) purely
 *  because tokens[] lists solana second. The MECHANISM is general (any fund with
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
const BACKFILL_ALLOWED: Record<string, readonly string[]> = {
  // OUSG (asset 57): four tiny networks (probe 2026-09-16: 2,271 / 12 / 50 / 56
  // records) that cost ~145 requests only because the 60-day span cap makes a sparse
  // network pay ~2 requests per window. Listed FIRST because funds drain the pool in
  // this object's key order — behind usdy it would get nothing until usdy:solana
  // finishes ~950 pages. Inside it, the two never-before-fetched chains go first so a
  // surprise surfaces in slot one. State-building only: OUSG stays on the Etherscan
  // nightly path until the dust-floor decision unblocks its cutover (not in
  // RWA_MULTICHAIN_SLUGS). XRPL mints/burns carry the issuer address as counterparty —
  // handled by normalizeTransaction's slug-guarded coercion (transfers.ts).
  ousg: ['xrp-ledger', 'solana', 'polygon', 'ethereum'],
  usdy: ['ethereum', 'arbitrum', 'mantle', 'plume', 'aptos', 'sei', 'stellar', 'solana'],
}

/** Per-run request budget (pages) — a SINGLE shared pool drawn down across every
 *  in-progress (fund, network) in the run, not one budget per network. Stays under
 *  rwa.xyz's 120/hr with headroom for the nightly's ~10-15 requests if they land in
 *  the same rolling hour: even a worst-case backfill+nightly overlap (80 + ~15) sits
 *  under 120, and the shared pool means adding networks does NOT scale the spend —
 *  two networks share these 80 pages rather than spending 80 each. See
 *  src/lib/rwa/backfill-budget.ts for the sequential-exhaust allocation policy. */
const BACKFILL_PER_RUN_PAGES = 80
// Window sizing (exact-count preflight, span bounds, clamp) + the shrink-on-failure
// helper live in src/lib/rwa/backfill-span.ts (imported above) so the math is
// unit-testable offline. Only the persisted-span I/O (loadBackfillSpanDays /
// saveBackfillSpanDays) lives here — it's what carries the learned/halved span across
// the 3-hourly slots. NOTE the pool is a REQUEST budget, not a time budget: a page
// takes ~8-16 s (measured 2026-09-15), so 80 pages is ~20-28 min of wall-clock; the
// workflow's timeout-minutes must leave room for that plus the worst window.

/** A rwa.xyz 429 surfaces as a thrown Error whose message carries `HTTP 429` (the
 *  http layer keeps its `rwa.xyz <endpoint> failed (page N): HTTP <status> — <body>`
 *  shape stable and does NOT retry 429s). A 429 is a global rate-limit signal, so the
 *  backfill uses it to end the whole run — not just the offending network.
 *
 *  The `rwa.xyz` prefix is REQUIRED. A Solana RPC 429 ("HTTP 429 from https://…",
 *  wrapped by json-rpc.ts as "… failed on all N endpoint(s): …") used to match a bare
 *  /HTTP 429/ and end the whole run as if rwa.xyz had rate-limited — and with two of
 *  the three default endpoints dead (see solana-rpc.ts) that is one endpoint's
 *  rate limit ending every network's slot. */
const isRateLimitError = (err: Error) => /^rwa\.xyz .*HTTP 429\b/.test(err.message)

/** A chain-RPC failure: json-rpc.ts tried every endpoint and all failed (429, 5xx,
 *  timeout, malformed). Transient, and its likelihood scales with the window (more
 *  addresses ⇒ more getMultipleAccounts batches), so it is a window-SIZE failure:
 *  halve and isolate this network — never end the run, it says nothing about rwa.xyz. */
const isChainRpcFailure = (err: Error) => /failed on all \d+ endpoint\(s\)/.test(err.message)

/**
 * Is this failure evidence the WINDOW WAS TOO BIG, i.e. should the adaptive span
 * shrink? Only transport-shaped failures qualify: a 429 (rate limit), a per-request
 * timeout, or an exhausted 5xx retry — all of which a smaller window plausibly avoids.
 *
 * Everything else is DETERMINISTIC: a decimals mismatch, a null counterparty on a
 * non-mint/burn, an unresolvable Solana address. Re-opening a half-sized window cannot
 * fix any of them, and halving on them is actively harmful — it drives the span to the
 * 1-day floor and then re-opens the identical failing window every slot, forever. That
 * is exactly how USDY Solana sat frozen at [2025-11-13, +1d) for seven weeks: the
 * closed-ATA guard fired, the span shrank, and the next slot re-derived the same
 * window. See _local/solana-ata-resolution-design.md §A7.
 */
const isWindowSizeFailure = (err: Error) =>
  isRateLimitError(err) ||
  isChainRpcFailure(err) ||
  /timed out \(page \d+\)/.test(err.message) ||
  /HTTP 5\d\d\b/.test(err.message)
/** Unix seconds → 'YYYY-MM-DD' (UTC). */
const toDayStr = (unixSec: number) => new Date(unixSec * 1000).toISOString().slice(0, 10)

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

/** Persisted per-network window span (days). Carries the adaptive sizer's learned
 *  density AND a shrink-on-failure across the 3-hourly slots — a 429 ends the run, so
 *  without persistence the span reset to INITIAL every slot and re-opened the same
 *  too-big window (the USDY Solana freeze). Null (fresh row / column not yet migrated)
 *  ⇒ caller uses INITIAL. Defensive: any read error returns null so backfill still runs. */
async function loadBackfillSpanDays(slug: string, network: string): Promise<number | null> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('fetch_cursor')
    .select('backfill_span_days')
    .eq('product_slug', slug)
    .eq('network', network)
    .maybeSingle()
  if (error) {
    console.warn(`  [backfill] span read failed for ${slug}:${network} (${error.message}) — using initial span`)
    return null
  }
  return (data as { backfill_span_days?: number | null } | null)?.backfill_span_days ?? null
}

/** Persist the next window span for (slug, network). The row already exists (markBackfill-
 *  InProgress upserts it). Non-fatal on error (pre-migration or transient) — the backfill
 *  continues, just without cross-slot span memory (i.e. the old INITIAL-every-slot behavior). */
async function saveBackfillSpanDays(slug: string, network: string, spanDays: number): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase
    .from('fetch_cursor')
    .update({ backfill_span_days: spanDays })
    .eq('product_slug', slug)
    .eq('network', network)
  if (error) {
    console.warn(`  [backfill] span persist failed for ${slug}:${network} (${error.message}) — not carried to next slot`)
  }
}

/**
 * Completion check for a network whose windows have reached the trailing edge:
 * Σ of ALL merged balances (negatives included) must equal rwa.xyz /v4/assets
 * supply for the network, within 1e-6 relative (floor 1 token). This is an
 * INTERNAL-CONSISTENCY check — our replay of their feed against their own ledger
 * replay — not chain verification (that is the reconciliation tripwire). It is the
 * identity that exposed usdy:arbitrum (Σ 2.73M vs 3.18M): a 450,000 token-mint the
 * feed had not indexed when the backfill completed. A mismatch means the feed is
 * still behind (or has holes we have not consumed): the network stays in_progress
 * and re-checks next slot for the cost of one probe, one boundary-day page and one
 * /v4/assets request. Only a verified match marks it complete.
 *
 * NOT used: /v4/assets `trailing_30_day_transfer_count`. Probed 2026-09-17, it is not
 * the same quantity as a day-bounded feed record count (usdy:sei 18,927 vs 11,676;
 * ustb:ethereum 2,041 vs 3,110; Solana's dual feed doubles the feed side), so a
 * "feed ≥ assets" gate would block some networks forever and pass others trivially.
 *
 * A null/failed assets reference does NOT complete the network (the Aptos precedent:
 * an empty or missing answer at an edge is never proof); it logs and retries next slot.
 */
async function verifyBackfillCaughtUp(
  product: Product,
  net: { networkId: number; networkSlug: string; addresses: string[]; decimals: number },
  state: BalanceStateMap,
  tag: string
): Promise<boolean> {
  let sumRaw = BigInt(0)
  let positiveRaw = BigInt(0)
  let holderCount = 0
  let negativeCount = 0
  for (const h of state.values()) {
    sumRaw += h.balance
    if (h.balance > BigInt(0)) { positiveRaw += h.balance; holderCount++ }
    else if (h.balance < BigInt(0)) negativeCount++
  }
  const sumAll = toTokens(sumRaw, net.decimals)
  let supply: number | null
  try {
    const byToken = await fetchAssetSupplyByToken(product.rwaAssetId!)
    const r = sumSupplyForNetwork(byToken, net.addresses, net.decimals, tag)
    supply = r.supplyTokens
    if (r.missing.length > 0) supply = null
  } catch (err) {
    console.warn(`  ${tag}: caught up to the feed's edge but /v4/assets is unavailable (${(err as Error).message.slice(0, 100)}) — leaving in_progress, re-check next slot`)
    return false
  }
  if (supply == null) {
    console.warn(`  ${tag}: caught up to the feed's edge but /v4/assets has no supply for this network's token(s) — leaving in_progress, re-check next slot`)
    return false
  }
  const tolerance = Math.max(1, 1e-6 * Math.abs(supply))
  const delta = sumAll - supply
  if (Math.abs(delta) <= tolerance) {
    console.log(`  ${tag}: Σ balances ${sumAll.toLocaleString()} == /v4/assets ${supply.toLocaleString()} (|Δ| ${Math.abs(delta).toExponential(2)} ≤ ${tolerance.toExponential(2)}) — backfill COMPLETE`)
    return true
  }
  console.warn(
    `  ${tag}: caught up to the feed's edge but Σ balances ${sumAll.toLocaleString()} ≠ /v4/assets ${supply.toLocaleString()} ` +
    `(Δ ${delta > 0 ? '+' : ''}${delta.toLocaleString()} tokens, ${((delta / supply) * 100).toFixed(4)}%) — either the feed is behind / ` +
    `has records we have not consumed, or rwa.xyz's assets stat is off from its own ledger (ustb:ethereum: 3.1%). ` +
    `Falling back to the chain reference.`
  )

  // Fallback: the tripwire's own chain comparison (Σ positive vs on-chain supply, 3%
  // threshold). Complete only if the chain confirms the state; persist the outcome to
  // reconciliation_history (context 'backfill') so the skew is on record, not just in
  // a CI log. No chain reference / failed read / > threshold ⇒ stay in_progress.
  let chain: ChainSupply | null = null
  let chainError: string | null = null
  try {
    chain = await fetchChainSupply(net.networkId, net.addresses, net.decimals, tag)
  } catch (err) {
    chainError = (err as Error).message
  }
  const r = evaluateReconciliation({
    stateTokens: toTokens(positiveRaw, net.decimals),
    holderCount,
    negativeCount,
    chain,
    chainError,
    assetsSupplyTokens: supply,
    navUsd: getNavUsd(product),
  })
  const decision = decideBackfillCompletion(r)
  const row: ReconciliationHistoryRow = {
    product_slug: product.slug,
    network: net.networkSlug,
    context: 'backfill',
    outcome: r.outcome,
    reference: chain?.reference ?? null,
    state_tokens: toTokens(positiveRaw, net.decimals),
    holder_count: holderCount,
    negative_count: negativeCount,
    chain_supply_tokens: chain?.supplyTokens ?? null,
    assets_supply_tokens: supply,
    deviation_pct: r.deviationPct,
    assets_delta_pct: r.assetsDeltaPct,
    notional_usd: r.notionalUsd,
    threshold_pct: r.thresholdPct,
    strict: false,
  }
  try {
    await insertReconciliationHistory(row)
  } catch (err) {
    console.warn(`  ${tag}: reconciliation_history write failed (${(err as Error).message}) — completion decision still applied`)
  }
  if (decision.complete) {
    console.warn(`  ${tag}: COMPLETE via chain reference — ${decision.reason}. /v4/assets ≠ Σ balances by ${((delta / supply) * 100).toFixed(4)}% is a source-side skew; persisted to reconciliation_history (context backfill).`)
    return true
  }
  console.warn(`  ${tag}: leaving in_progress — ${decision.reason}; re-check next slot (last real cursor kept, no synthetic advance)`)
  return false
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
      // NEVER mark complete here. Completion requires a persisted cursor (≥1 window
      // written); an empty first answer is not proof there is nothing to fill.
      // usdy:aptos was flagged complete with 0 rows / null cursor on 2026-07-25 by
      // exactly this rung, while rwa.xyz holds ~12k Aptos transactions (its feed was
      // evidently mid-re-index — the count later SHRANK from ~24k to 11.8k). The row
      // stays in_progress (marked above) and this rung re-checks next slot at the
      // cost of one request. /v4/assets is the cross-check: supply on a network with
      // no transactions is an rwa.xyz feed gap; null/0 supply is a config decision
      // (behaviorallyObservable:false), never something the backfill decides alone.
      let supply: number | null = null
      let supplyErr: string | null = null
      try {
        const byToken = await fetchAssetSupplyByToken(product.rwaAssetId!)
        supply = sumSupplyForNetwork(byToken, net.addresses, net.decimals, tag).supplyTokens
      } catch (err) {
        supplyErr = (err as Error).message
      }
      if (supplyErr != null) {
        console.warn(`  ${tag}: no transactions on this network and /v4/assets cross-check failed (${supplyErr}) — leaving in_progress, will re-check next slot`)
      } else if (supply != null && supply > 0) {
        console.warn(`  ${tag}: rwa.xyz has supply (${supply.toLocaleString()} tokens) but no transactions — feed gap, leaving in_progress`)
      } else {
        console.warn(
          `  ${tag}: no transactions AND /v4/assets supply is ${supply == null ? 'null' : supply} — NOT auto-completing. ` +
          `If this network is genuinely unobservable, set behaviorallyObservable:false in products.ts (config decision); ` +
          `it stays in_progress until then.`
        )
      }
      return
    }
    frontierDay = earliest
    console.log(`  ${tag}: fresh backfill from earliest tx date ${earliest}`)
  }

  // Resume CANDIDATE span: the density-appropriate span learned & PERSISTED by the
  // last slot, or halved by a prior window failure / job kill (the halved value is
  // written BEFORE every window opens — see below). Null (fresh / pre-migration) ⇒
  // INITIAL. Clamped in case of a stale/bad stored value. It is only a candidate:
  // every window is sized from an EXACT count before it opens, so the candidate can
  // never open an oversized window at a sparse→dense boundary.
  let spanDays = clampSpan((await loadBackfillSpanDays(product.slug, net.networkSlug)) ?? BACKFILL_INITIAL_SPAN_DAYS)
  let pagesThisNetwork = 0

  // Draw from the SHARED run pool: this network keeps taking windows until the
  // pool (not a per-network budget) is dry or it catches up to the present.
  while (budget.remaining > 0) {
    if (frontierDay >= todayDay) {
      // Real data reached today. Still verify before completing (see verifyBackfillCaughtUp).
      console.log(`  ${tag}: reached present (${frontierDay} ≥ ${todayDay}) — verifying Σ balances against /v4/assets`)
      if (await verifyBackfillCaughtUp(product, net, state, tag)) await markBackfillComplete(product.slug, net.networkSlug)
      return
    }

    // Preflight: size this window from an EXACT count (one perPage=1 request per
    // probe), capped at min(TARGET, pool remaining), so the window's cost is known
    // before a single page is fetched. This bounds pages WITHIN a window (the pool only
    // gates BETWEEN windows) and replaces density extrapolation, which at a sparse→
    // dense boundary opened a 97-page window that could never finish in the job
    // timeout. Probes are real requests: charged to the pool like pages.
    const pageCap = Math.min(BACKFILL_TARGET_PAGES, budget.remaining)
    const preflight = await sizeWindowByPreflight({
      frontierDay,
      todayDay,
      candidateSpanDays: spanDays,
      pageCap,
      countPages: async (gte, lt) =>
        (await countTransfersWindowPagesRWA(product.rwaAssetId!, net.networkId, gte, lt)).pages,
    })
    pagesThisNetwork += preflight.probes
    budget.remaining -= preflight.probes
    const openSpan = preflight.spanDays
    const windowEnd = preflight.windowEnd
    if (preflight.overCap) {
      console.warn(
        `  ${tag}: window [${frontierDay}, ${windowEnd}) counts ${preflight.pages}pg — over the ${pageCap}pg cap ` +
        `at ${openSpan}d after ${preflight.probes} probe(s); opening anyway (progress over stall — the job ` +
        `timeout is the backstop)`
      )
    } else {
      console.log(
        `  ${tag}: preflight sized window [${frontierDay}, ${windowEnd}) at ${openSpan}d = ${preflight.pages}pg ` +
        `(${preflight.probes} probe(s), cap ${pageCap})`
      )
    }

    // Kill-safety: persist the HALVED span BEFORE the fetch. A job-timeout kill is a
    // SIGTERM — no catch block runs — so without this the span survived a kill intact
    // and the identical window was re-opened every slot. Now a kill leaves half the
    // span behind. A completed window overwrites this with the learned span below; a
    // deterministic failure restores the candidate (halving cannot fix those and drives
    // the span to the floor — design doc §A7); a size failure keeps it.
    const halved = halveSpanOnFailure(openSpan)
    await saveBackfillSpanDays(product.slug, net.networkSlug, halved)

    let windowResult
    try {
      windowResult = await fetchTransfersWindowRWA(
        product.rwaAssetId!, net.networkId, net.decimals, net.addresses, frontierDay, windowEnd
      )
    } catch (err) {
      const e = err as Error
      if (isWindowSizeFailure(e)) {
        // Shrink-on-failure: this span was too big for the frontier/era (429, timeout,
        // or a chain-RPC outage mid-window). The halved span is ALREADY persisted, so
        // the NEXT slot retries a smaller window — a rwa.xyz 429 must still drain the
        // pool and end the run (not an in-run retry). The window itself was discarded
        // before writeBack, so the cursor is unmoved.
        console.warn(
          `  ${tag}: window [${frontierDay}, ${windowEnd}) failed — span halved to ${halved}d for ` +
          `next slot: ${e.message.slice(0, 100)}`
        )
      } else {
        // Deterministic failure — a smaller window re-derives it identically, so the
        // candidate is RESTORED (shrinking on these is what froze USDY Solana). Surface
        // it in full: these errors name what to fix.
        await saveBackfillSpanDays(product.slug, net.networkSlug, spanDays)
        console.error(
          `  ${tag}: window [${frontierDay}, ${windowEnd}) failed DETERMINISTICALLY — span restored to ` +
          `${spanDays}d (a smaller window would fail identically). Needs a fix, not a retry:\n${e.message}`
        )
      }
      throw err // preserve 429-drains-pool / graceful-end semantics
    }
    const { transfers, pages } = windowResult
    pagesThisNetwork += pages
    budget.remaining -= pages

    // Dedup the inclusive-gte boundary day already processed last window, merge,
    // and checkpoint. Windows are disjoint [start,end), so this only ever removes
    // the cursor-day overlap on a resume.
    const newTransfers = dedupBoundary(transfers, cursor?.boundaryIds ?? null)
    state = mergeTransfers(state, newTransfers, net.caseSensitive).merged

    let newCursor: FetchCursor
    if (newTransfers.length > 0) {
      newCursor = computeNewCursor(newTransfers, cursor)! // non-null: newTransfers non-empty
    } else {
      // Empty window. In the INTERIOR of history that is a genuine gap: advance a
      // synthetic cursor (no boundary ids) past it so we don't re-scan the same empty
      // range forever. Inside the trailing lag band (today − BACKFILL_TRAILING_LAG_DAYS
      // … today) it proves nothing — rwa.xyz may simply not have indexed the records
      // yet — so a synthetic cursor may reach the band's start but never enter it.
      // A window wholly inside the band writes NO cursor: the last real record stays
      // the resume point (with its boundary ids), and the network is treated as
      // caught up to the feed's edge, completing only if Σ balances agrees with
      // /v4/assets. This is what would have kept usdy:arbitrum's 07-24 mint.
      const target = syntheticAdvanceTarget(frontierDay, windowEnd, todayDay)
      if (target == null || target <= frontierDay) {
        spanDays = nextSpanFromDensity(openSpan, pages)
        await saveBackfillSpanDays(product.slug, net.networkSlug, spanDays)
        console.log(
          `  ${tag}: empty window [${frontierDay}, ${windowEnd}) lies inside the trailing lag band ` +
          `(from ${lagBandStart(todayDay)}, ${BACKFILL_TRAILING_LAG_DAYS}d) — no synthetic cursor; cursor stays at ` +
          `${cursor?.lastTxTimestamp ?? 'null'}`
        )
        if (await verifyBackfillCaughtUp(product, net, state, tag)) await markBackfillComplete(product.slug, net.networkSlug)
        return
      }
      if (target < windowEnd) {
        console.log(`  ${tag}: empty window [${frontierDay}, ${windowEnd}) straddles the trailing lag band — synthetic advance bounded to ${target}`)
      }
      newCursor = { lastTxTimestamp: `${target}T00:00:00.000Z`, boundaryIds: [] }
    }

    // Persist balances + cursor ONLY (apply_incremental_merge). No classifications /
    // aggregate / behavior writes — partial-state guard (state still incomplete).
    await deps.writeBack({ productSlug: product.slug, network: net.networkSlug, merged: state, newCursor })

    cursor = newCursor
    frontierDay = cursor.lastTxTimestamp.slice(0, 10)

    // Next CANDIDATE from THIS window's exact density, aimed at ~TARGET pages. Persist
    // it (overwriting the pre-fetch halved value) so the next slot resumes at the
    // era-correct span, not INITIAL. Growing into a denser era is safe: the preflight
    // above re-counts the candidate before it opens.
    spanDays = nextSpanFromDensity(openSpan, pages)
    await saveBackfillSpanDays(product.slug, net.networkSlug, spanDays)

    console.log(
      `  ${tag}: window [${frontierDay}…] done — ${pages}pg (span ${openSpan}d), ${newTransfers.length} new, ` +
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
  if (!allowed || allowed.length === 0) {
    console.log(`[${product.slug}] not enabled for chunked backfill — clean no-op.`)
    return
  }
  // Priority order is BACKFILL_ALLOWED's list order, not tokens[] order.
  const priority = new Map(allowed.map((slug, i) => [slug, i] as const))
  const networks = observableNetworks(product)
    .filter((net) => priority.has(net.networkSlug))
    .sort((a, b) => priority.get(a.networkSlug)! - priority.get(b.networkSlug)!)
  console.log(`\n[${product.slug}] BACKFILL (chunked, resumable) — enabled network(s), priority order: ${allowed.join(', ')}`)

  // Sequential-exhaust across this fund's networks (priority order), all drawing
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
  // Every mode (nightly, BACKFILL, REANCHOR) can hit the Solana resolver; say which
  // RPC list it will use so a misconfigured secret is visible, not silent.
  logRpcEndpointsInUse()

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
