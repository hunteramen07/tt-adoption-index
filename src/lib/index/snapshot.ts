/**
 * Writes per-product monthly snapshots to the Supabase `snapshots` table.
 *
 * Required table:
 *
 *   CREATE TABLE snapshots (
 *     snapshot_date      date    NOT NULL,
 *     product            text    NOT NULL,
 *     network            text    NOT NULL,  -- added 2026-06-17; no DEFAULT since 2026-09-21
 *     aum                numeric NOT NULL,  -- USD (supply × hardcoded NAV)
 *     holder_count       integer NOT NULL,
 *     top5_share         numeric NOT NULL,  -- fraction 0–1
 *     dormancy_share     numeric NOT NULL,  -- fraction 0–1
 *     transfer_volume_30d numeric NOT NULL, -- USD, non-mint/burn transfers
 *     PRIMARY KEY (snapshot_date, product, network)
 *   );
 *
 * The index backfill is Ethereum-only (Etherscan transfer cache + Dune AUM series),
 * so every row it writes is network 'ethereum' — stated explicitly rather than left
 * to a column default. Found 2026-09-21: after the network dimension landed (PK now
 * includes network) this writer's ON CONFLICT still named the old two-column key,
 * so the next manual `npm run backfill` would have failed on the upsert. Nothing
 * writes snapshots on a schedule; the last rows are 2026-05-31.
 */

/** The only network the index backfill covers today. */
const SNAPSHOT_NETWORK = 'ethereum'

import { getSupabase } from '@/src/lib/supabase/client'
import type { ProductSnapshot } from './types'

export async function writeSnapshots(snapshots: ProductSnapshot[]): Promise<void> {
  if (snapshots.length === 0) return
  const supabase = getSupabase()

  const rows = snapshots.map((s) => ({
    snapshot_date: s.snapshotDate,
    product: s.product,
    network: SNAPSHOT_NETWORK,
    aum: s.aum,
    holder_count: s.holderCount,
    top5_share: s.top5Share,
    dormancy_share: s.dormancyShare,
    transfer_volume_30d: s.transferVolume30d,
  }))

  const { error } = await supabase
    .from('snapshots')
    .upsert(rows, { onConflict: 'snapshot_date,product,network' })

  if (error) throw new Error(`snapshots upsert failed: ${error.message}`)
}
