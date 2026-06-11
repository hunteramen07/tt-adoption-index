/**
 * npm run backfill
 *
 * Reconstructs historical monthly RTA Index readings as far back as the
 * cached data allows, then writes them to Supabase.
 *
 * Prerequisites:
 *   1. Run `npm run classify` at least once to populate the transfer history
 *      disk cache (.cache/etherscan/).
 *   2. DUNE_API_KEY, NEXT_PUBLIC_SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY
 *      (or NEXT_PUBLIC_SUPABASE_ANON_KEY) must be set in .env.local.
 *   3. Create the `snapshots` and `index_readings` tables in Supabase
 *      (DDL in src/lib/index/snapshot.ts and reading.ts).
 *
 * After the backfill a table of raw factor values is printed to stdout.
 * DO NOT finalize normalization ranges in src/config/index-ranges.ts until
 * you have reviewed that table and calibrated the ranges accordingly.
 *
 * Flags:
 *   --dry-run   Print the calibration table without writing to the database.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { runBackfill } from '@/src/lib/index/backfill'

const dryRun = process.argv.includes('--dry-run')

if (dryRun) {
  console.log('[backfill] dry-run mode — no database writes')
}

runBackfill({ writeToDb: !dryRun, verbose: true }).catch((err) => {
  console.error('\n[backfill] fatal error:', err)
  process.exit(1)
})
