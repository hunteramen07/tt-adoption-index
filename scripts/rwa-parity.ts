/**
 * npm run test:rwa-parity
 *
 * Standalone parity-check tool — NOT wired into the pipeline. Fetches the full
 * BUIDL/Ethereum distributed-class transfer history via the rwa.xyz fetch path
 * (src/lib/rwa/transfers.ts), runs it through the EXISTING classify engine, and
 * prints the resulting holder/behavior metrics so they can be compared against
 * the Etherscan-based output (Stage 1 → Stage 2 parity gate).
 *
 * Read-only: fetches, computes, and prints. Writes nothing to Supabase or disk.
 * Requires RWA_API_KEY in .env.local. This fetches the FULL history (no page
 * cap), so it makes many rwa.xyz requests and can take a while.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { fetchTransfersRWA } from '@/src/lib/rwa/transfers'
import {
  classifyHolders,
  computeBehavioralMix,
  computeDormancySharePct,
  computeAggregateStats,
} from '@/src/lib/classify/engine'

async function main() {
  console.log('=== rwa.xyz ↔ engine parity check: BUIDL / Ethereum ===')

  console.log('fetching full distributed-class history (no page cap)…')
  const transfers = await fetchTransfersRWA(
    2331, // BUIDL asset_id
    1, // Ethereum network_id
    6, // decimals
    ['0x7712c34205737192402172409a8f7ccef8aa2aec'] // distributed class only (excludes BUIDL-I)
  )
  console.log(`post-filtered transfers fetched: ${transfers.length}`)

  const nowTs = Math.floor(Date.now() / 1000)

  const classifications = classifyHolders(transfers, nowTs)
  const mix = computeBehavioralMix(classifications)
  const dormancySharePct = computeDormancySharePct(classifications)
  const agg = computeAggregateStats(transfers, nowTs)

  console.log('\n--- summary ---')
  console.log(`total transfers fetched : ${transfers.length}`)
  console.log(`holder count            : ${mix.total}`)
  console.log(`dormancy share %        : ${dormancySharePct.toFixed(2)}`)
  console.log('behavior mix:')
  console.log(`  accumulating          : ${mix.accumulating}`)
  console.log(`  distributing          : ${mix.distributing}`)
  console.log(`  dormant               : ${mix.dormant}`)
  console.log(`  active                : ${mix.active}`)
  console.log('aggregate stats:')
  console.log(`  net new wallets 90d   : ${agg.netNewWallets90d}`)
  console.log(`  exited wallets 90d    : ${agg.exitedWallets90d}`)
  console.log(
    `  net accumulation ratio: ${
      agg.netAccumulationRatio === null ? 'n/a' : agg.netAccumulationRatio.toFixed(4)
    }`
  )
}

main().catch((err) => {
  console.error('\n[rwa-parity] fatal error:', err)
  process.exit(1)
})
