/**
 * npm run classify
 *
 * Classifies all token holder addresses for BUIDL, OUSG, USTB, USYC
 * (per-wallet rows) and USDY (aggregate stats only), then writes results
 * to Supabase.
 *
 * Resumable: completed products are recorded in .cache/classify-progress.json.
 * Restart the script after a failure — it picks up where it left off as long
 * as the progress file is < 12 hours old.
 *
 * ── Required Supabase tables ──────────────────────────────────────────────
 *
 * CREATE TABLE holder_classifications (
 *   product_slug       text NOT NULL,
 *   address            text NOT NULL,
 *   behavior           text NOT NULL,   -- Accumulating | Distributing | Dormant | Active
 *   balance_raw        text NOT NULL,
 *   inflow_raw         text NOT NULL DEFAULT '0',
 *   outflow_raw        text NOT NULL DEFAULT '0',
 *   is_labeled_custodian boolean NOT NULL DEFAULT false,
 *   name_tag           text,
 *   classified_at      timestamptz NOT NULL,
 *   as_of_block        integer NOT NULL,
 *   PRIMARY KEY (product_slug, address)
 * );
 *
 * CREATE TABLE holder_aggregate_stats (
 *   product_slug             text PRIMARY KEY,
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
 *   as_of_block              integer NOT NULL
 * );
 *
 * CREATE TABLE behavior_history (         -- append-only behavior log over time
 *   product_slug          text        NOT NULL,
 *   dormancy_share_pct    numeric     NOT NULL,
 *   holder_count          integer     NOT NULL,
 *   behavior_accumulating integer     NOT NULL,
 *   behavior_distributing integer     NOT NULL,
 *   behavior_dormant      integer     NOT NULL,
 *   behavior_active       integer     NOT NULL,
 *   recorded_at           timestamptz NOT NULL DEFAULT now(),
 *   PRIMARY KEY (product_slug, recorded_at)
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
import { ACTIVE_PRODUCTS } from '@/src/config/products'
import { fetchTransferHistory } from '@/src/lib/etherscan/transfers'
import { etherscanGet } from '@/src/lib/etherscan/client'
import { diskCacheRead, diskCacheWrite } from '@/src/lib/cache/disk'
import { KNOWN_ADDRESSES } from '@/src/lib/etherscan/nameTags'
import type { ContractSource } from '@/src/lib/etherscan/types'
import {
  classifyHolders,
  computeDormancySharePct,
  computeBehavioralMix,
  computeAggregateStats,
} from '@/src/lib/classify/engine'
import type { HolderClassification } from '@/src/lib/classify/types'
import { getSupabase } from '@/src/lib/supabase/client'

// ── Constants ──────────────────────────────────────────────────────────────

const PROGRESS_FILE = path.join(process.cwd(), '.cache', 'classify-progress.json')
const PROGRESS_TTL_MS = 12 * 60 * 60 * 1000
const UPSERT_BATCH = 500

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
  asOfBlock: number
): Promise<void> {
  const supabase = getSupabase()
  const classifiedAt = new Date().toISOString()

  const rows = Array.from(classifications.values()).map((c) => ({
    product_slug: productSlug,
    network: 'ethereum',
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
    if (error) throw new Error(`Supabase upsert failed (${productSlug} batch ${i}): ${error.message}`)
    console.log(`  wrote ${i + batch.length}/${rows.length} rows`)
  }

  // Remove stale rows: addresses that existed in a previous run but are no
  // longer current holders (zero balance today). Identified by classified_at
  // predating this run's timestamp.
  const { error: deleteError } = await supabase
    .from('holder_classifications')
    .delete()
    .eq('product_slug', productSlug)
    .lt('classified_at', classifiedAt)
  if (deleteError) throw new Error(`Supabase stale-row delete failed (${productSlug}): ${deleteError.message}`)
}

async function upsertAggregateStats(stats: ReturnType<typeof computeAggregateStats> & {
  productSlug: string
  asOfBlock: number
}): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase.from('holder_aggregate_stats').upsert({
    product_slug: stats.productSlug,
    network: 'ethereum',
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
  }, { onConflict: 'product_slug,network' })
  if (error) throw new Error(`Supabase upsert failed (aggregate ${stats.productSlug}): ${error.message}`)
}

// Append one row to behavior_history per fund per run. Unlike the aggregate
// upsert above, this is an INSERT (not an upsert): every run accumulates a new
// row so holder-behavior metrics build a time series instead of being
// overwritten. recorded_at is filled by the column's now() default.
async function insertBehaviorHistory(stats: ReturnType<typeof computeAggregateStats> & {
  productSlug: string
}): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase.from('behavior_history').insert({
    product_slug: stats.productSlug,
    network: 'ethereum',
    dormancy_share_pct: stats.dormancySharePct,
    holder_count: stats.holderCount,
    behavior_accumulating: stats.mix.accumulating,
    behavior_distributing: stats.mix.distributing,
    behavior_dormant: stats.mix.dormant,
    behavior_active: stats.mix.active,
  })
  if (error) throw new Error(`Supabase insert failed (behavior_history ${stats.productSlug}): ${error.message}`)
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

  for (const product of ACTIVE_PRODUCTS) {
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
      await upsertAggregateStats({ ...stats, productSlug: product.slug, asOfBlock: lastBlock })
      await insertBehaviorHistory({ ...stats, productSlug: product.slug })
    } else {
      // Per-wallet classification
      console.log(`  classifying holders…`)
      const classifications = classifyHolders(transfers, nowTs)
      const mix = computeBehavioralMix(classifications)
      const dormancySharePct = computeDormancySharePct(classifications)
      console.log(
        `  ${classifications.size} holders  dormancyShare=${dormancySharePct.toFixed(1)}%  ` +
        `mix: A=${mix.accumulating} D=${mix.distributing} Dormant=${mix.dormant} Active=${mix.active}`
      )

      // Resolve name tags for all holder addresses
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

      console.log(`  writing ${classifications.size} rows to Supabase…`)
      await upsertClassifications(product.slug, classifications, lastBlock)

      // Also write aggregate stats so the dashboard can read from Supabase
      // without replaying the full transfer history on every request.
      console.log(`  writing aggregate stats to Supabase…`)
      const aggStats = computeAggregateStats(transfers, nowTs)
      await upsertAggregateStats({ ...aggStats, productSlug: product.slug, asOfBlock: lastBlock })
      await insertBehaviorHistory({ ...aggStats, productSlug: product.slug })
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
