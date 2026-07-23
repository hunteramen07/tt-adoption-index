/**
 * Multi-chain write tails + mode routing (extracted from scripts/classify.ts so it
 * is importable and unit-testable offline — classify.ts runs main() on import).
 *
 * A merged per-network result is written one of two ways, chosen by fund mode:
 *   • per-wallet  — name-tag enrich (Ethereum only) + holder_classifications rows +
 *                   aggregate stats + behavior history. The default.
 *   • aggregate   — aggregate stats (with the market-value weight) + behavior history
 *                   ONLY. No per-wallet rows, no name tags, no stale-delete. Used by
 *                   aggregateFlowsOnly funds (USDY).
 *
 * Everything UPSTREAM of these tails (fetch/merge/persist balances+cursor, casing,
 * decimals guard, ATA resolution, market-value weight, reconciliation tripwire) is
 * shared and lives in classify.ts — only the tail differs.
 *
 * The four side-effecting writes are abstracted behind MultiChainWriters so the
 * routing + tails run against in-memory fakes in the parity test. classify.ts wires
 * the real Supabase/Etherscan-backed implementations.
 */

import type { Product } from '@/src/config/products'
import type { HolderClassification } from '@/src/lib/classify/types'
import type { computeAggregateStats } from '@/src/lib/classify/engine'

/** The aggregate-stats shape both tails consume (from computeAggregateStats /
 *  computeAggregateStatsFromState — identical output). */
export type AggregateStats = ReturnType<typeof computeAggregateStats>

export type WriteMode = 'aggregate' | 'per-wallet'

export interface NameTag {
  nameTag: string | null
  isCustodian: boolean
}

/**
 * The side-effecting write surface of the multi-chain tail. Injected so the tails
 * are testable offline; classify.ts supplies Supabase/Etherscan-backed versions.
 * The aggregate tail deliberately touches only a SUBSET (upsertAggregateStats +
 * insertBehaviorHistory) — the test asserts it never reaches for the other two.
 */
export interface MultiChainWriters {
  resolveNameTags(addresses: string[]): Promise<Map<string, NameTag>>
  upsertClassifications(
    productSlug: string,
    classifications: Map<string, HolderClassification>,
    asOfBlock: number,
    network: string
  ): Promise<void>
  upsertAggregateStats(
    stats: AggregateStats & { productSlug: string; asOfBlock: number },
    network: string,
    marketValueUsd: number | null
  ): Promise<void>
  insertBehaviorHistory(
    stats: AggregateStats & { productSlug: string },
    network: string
  ): Promise<void>
}

/** The write tail a fund's results take. aggregateFlowsOnly ⇒ aggregate; else
 *  per-wallet. Single source of truth for the routing decision (used both to pick
 *  the runIncrementalFetchMerge mode and to pick the write tail). */
export function selectWriteMode(product: Product): WriteMode {
  return product.aggregateFlowsOnly ? 'aggregate' : 'per-wallet'
}

/**
 * Per-wallet write tail (was enrichAndWriteClassifications): name-tag enrich on
 * Ethereum, write holder_classifications rows, then aggregate stats + behavior
 * history. Callers arrive with classifications + aggStats already computed — from
 * full history (Etherscan) or merged incremental state (rwa.xyz).
 */
export async function writePerWalletResult(
  writers: MultiChainWriters,
  product: Product,
  classifications: Map<string, HolderClassification>,
  aggStats: AggregateStats,
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
    const tags = await writers.resolveNameTags(addresses)

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
  await writers.upsertClassifications(product.slug, classifications, asOfBlock, network)

  // Also write aggregate stats so the dashboard can read from Supabase
  // without replaying the full transfer history on every request.
  console.log(`  writing aggregate stats to Supabase…`)
  await writers.upsertAggregateStats({ ...aggStats, productSlug: product.slug, asOfBlock }, network, marketValueUsd)
  if (writeBehaviorHistory) {
    await writers.insertBehaviorHistory({ ...aggStats, productSlug: product.slug }, network)
  } else {
    console.log(`  skipping behavior_history append (re-anchor is a repair, not an observation)`)
  }
}

/**
 * Aggregate write tail: aggregate stats (with the market-value weight) + a behavior
 * history row, and NOTHING else. No per-wallet holder_classifications rows, no
 * name-tag resolution (there are no rows to tag), no stale-delete. Mirrors the
 * Etherscan aggregate branch in main(), sourced from merged rwa state. as_of_block
 * is 0 for rwa (no block number on rwa.xyz transfers; unused in classify math).
 */
export async function writeAggregateResult(
  writers: MultiChainWriters,
  product: Product,
  aggStats: AggregateStats,
  network: string,
  marketValueUsd: number | null = null
): Promise<void> {
  const { mix, dormancySharePct, holderCount } = aggStats
  console.log(
    `  ${holderCount} holders  dormancyShare=${dormancySharePct.toFixed(1)}%  ` +
    `mix: A=${mix.accumulating} D=${mix.distributing} Dormant=${mix.dormant} Active=${mix.active}`
  )
  console.log(`  writing aggregate stats to Supabase (aggregate-only, no per-wallet rows)…`)
  await writers.upsertAggregateStats({ ...aggStats, productSlug: product.slug, asOfBlock: 0 }, network, marketValueUsd)
  await writers.insertBehaviorHistory({ ...aggStats, productSlug: product.slug }, network)
}
