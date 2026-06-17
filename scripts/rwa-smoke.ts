/**
 * npm run test:rwa
 *
 * Standalone smoke test for the parallel rwa.xyz fetch path
 * (src/lib/rwa/transfers.ts) — NOT part of the live pipeline. Pulls one page of
 * BUIDL/Ethereum transactions, post-filtered to the distributed class, and logs
 * the first 3 normalized transfers so the mapping can be eyeballed.
 *
 * Spec verification (Step 6): the 330.15-token transfer should have
 * value="330150000", timeStamp a real Unix-seconds value, from/to populated.
 * Requires RWA_API_KEY in .env.local.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { fetchTransfersRWA } from '@/src/lib/rwa/transfers'

async function main() {
  console.log('=== rwa.xyz smoke test ===')
  const transfers = await fetchTransfersRWA(
    2331, // BUIDL asset_id
    1, // Ethereum network_id
    6, // decimals
    ['0x7712c34205737192402172409a8f7ccef8aa2aec'], // distributed class only (excludes BUIDL-I)
    { maxPages: 1 }
  )

  console.log(`fetched ${transfers.length} transfers (1 page, post-filtered to distributed class)`)
  console.log('first 3 normalized transfers:')
  for (const t of transfers.slice(0, 3)) {
    console.log(
      JSON.stringify(
        { from: t.from, to: t.to, value: t.value, timeStamp: t.timeStamp, hash: t.hash },
        null,
        2
      )
    )
  }
}

main().catch((err) => {
  console.error('\n[rwa-smoke] fatal error:', err)
  process.exit(1)
})
