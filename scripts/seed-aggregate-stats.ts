/**
 * npm run seed-aggregate-stats
 *
 * One-shot back-fill: reads holder_classifications for each per-wallet product
 * and writes aggregate stats to holder_aggregate_stats.
 *
 * Use when holder_classifications already exists but holder_aggregate_stats is
 * missing rows (e.g., after an interrupted classify run or a script bug).
 *
 * netNewWallets90d and exitedWallets90d cannot be derived from the static
 * classification snapshot, so they are set to 0 in this back-fill.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { ACTIVE_PRODUCTS } from '@/src/config/products'
import { getSupabase } from '@/src/lib/supabase/client'

const ZERO = BigInt(0)

async function main() {
  const supabase = getSupabase()

  for (const product of ACTIVE_PRODUCTS) {
    if (product.aggregateFlowsOnly) {
      console.log(`[${product.slug}] skipping — aggregate-only, already has stats`)
      continue
    }

    const { data, error } = await supabase
      .from('holder_classifications')
      .select('address, behavior, balance_raw, classified_at, as_of_block')
      .eq('product_slug', product.slug)

    if (error) { console.error(`[${product.slug}] query error:`, error.message); continue }
    if (!data || data.length === 0) { console.log(`[${product.slug}] no rows — skipping`); continue }

    let accumulating = 0, distributing = 0, dormant = 0, active = 0
    let totalRaw = ZERO, noOutflowRaw = ZERO

    for (const row of data) {
      const bal = BigInt(row.balance_raw ?? '0')
      totalRaw += bal
      switch (row.behavior) {
        case 'Accumulating': accumulating++; noOutflowRaw += bal; break
        case 'Distributing': distributing++; break
        case 'Dormant': dormant++; noOutflowRaw += bal; break
        case 'Active': active++; break
      }
    }

    const holderCount = data.length
    const dormancySharePct = totalRaw > ZERO
      ? Number((noOutflowRaw * BigInt(10000)) / totalRaw) / 100
      : 0
    const directional = accumulating + distributing
    const netAccumulationRatio = directional > 0 ? accumulating / directional : null

    // Use the most recent classified_at and as_of_block from the rows
    const classifiedAt = data.map(r => r.classified_at).sort().at(-1) ?? new Date().toISOString()
    const asOfBlock = Math.max(...data.map(r => r.as_of_block ?? 0))

    const row = {
      product_slug: product.slug,
      holder_count: holderCount,
      behavior_accumulating: accumulating,
      behavior_distributing: distributing,
      behavior_dormant: dormant,
      behavior_active: active,
      dormancy_share_pct: dormancySharePct,
      net_new_wallets_90d: 0,   // not derivable from static snapshot
      exited_wallets_90d: 0,
      net_accumulation_ratio: netAccumulationRatio,
      classified_at: classifiedAt,
      as_of_block: asOfBlock,
    }

    const { error: upsertError } = await supabase
      .from('holder_aggregate_stats')
      .upsert(row, { onConflict: 'product_slug' })

    if (upsertError) {
      console.error(`[${product.slug}] upsert error:`, upsertError.message)
    } else {
      console.log(
        `[${product.slug}] ✓  holders=${holderCount}  dormancy=${dormancySharePct.toFixed(1)}%  ` +
        `mix: A=${accumulating} D=${distributing} Dormant=${dormant} Active=${active}`
      )
    }
  }

  console.log('\ndone')
}

main().catch((err) => { console.error(err); process.exit(1) })
