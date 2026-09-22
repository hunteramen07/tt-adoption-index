/**
 * npm run backfill [-- --refresh] [-- --dry-run]
 *
 * Reconstructs monthly RTA Index readings (snapshots + index_readings) for every
 * complete month-end from the earliest cached data through last month, and writes
 * them to Supabase. Idempotent: every month is upserted, so re-running recomputes
 * history under the CURRENT hardcoded NAVs (products.ts) — see the NAV caveat in
 * src/lib/index/backfill.ts.
 *
 * This is the monthly index reading. It was a manual first-of-month task and lapsed
 * after 2026-05-31 (June–August 2026 readings were missing until 2026-09-22); it now
 * also runs from .github/workflows/index-monthly.yml on the 1st.
 *
 * Inputs:
 *   • Ethereum transfer histories from the disk cache (.cache/etherscan/,
 *     `transfers-<contract>`). The nightly no longer populates it for the funds on
 *     the rwa.xyz multi-chain path (BUIDL, USTB, USYC), and CI has no persisted
 *     cache at all — so pass --refresh to pull every active fund's history through
 *     fetchTransferHistory first (incremental from the cached lastBlock; a full pull
 *     on a cold cache). Without it, a stale cache silently truncates recent months.
 *   • The Dune supply/AUM series (DUNE_API_KEY; refreshed nightly by refresh-dune.yml).
 *   • ETHERSCAN_API_KEY (with --refresh), NEXT_PUBLIC_SUPABASE_URL and a key.
 *
 * After the backfill a table of raw factor values is printed to stdout.
 * DO NOT finalize normalization ranges in src/config/index-ranges.ts until
 * you have reviewed that table and calibrated the ranges accordingly.
 *
 * Flags:
 *   --refresh   Refresh the Etherscan transfer cache for every active fund first.
 *   --dry-run   Print the calibration table without writing to the database.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { ACTIVE_PRODUCTS } from '@/src/config/products'
import { fetchTransferHistory, ETHERSCAN_MAX_PAGE_SIZE } from '@/src/lib/etherscan/transfers'
import { runBackfill } from '@/src/lib/index/backfill'

const dryRun = process.argv.includes('--dry-run')
const refresh = process.argv.includes('--refresh')

async function main() {
  if (dryRun) console.log('[backfill] dry-run mode — no database writes')

  if (refresh) {
    console.log('[backfill] --refresh: pulling Ethereum transfer histories for every active fund…')
    for (const product of ACTIVE_PRODUCTS) {
      const t0 = Date.now()
      const h = await fetchTransferHistory(product, { pageSize: ETHERSCAN_MAX_PAGE_SIZE })
      const last = h.transfers.length > 0 ? new Date(parseInt(h.transfers[h.transfers.length - 1].timeStamp) * 1000).toISOString().slice(0, 10) : 'none'
      console.log(`  ${product.slug}: ${h.transfers.length} transfers through block ${h.lastBlock} (last ${last}, fromCache=${h.fromCache}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`)
    }
  } else {
    console.log('[backfill] using the transfer cache as-is (pass --refresh to pull recent history first)')
  }

  await runBackfill({ writeToDb: !dryRun, verbose: true })
}

main().catch((err) => {
  console.error('\n[backfill] fatal error:', err)
  process.exit(1)
})
