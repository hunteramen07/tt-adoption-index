/**
 * Writes per-product monthly snapshots to the Supabase `snapshots` table.
 *
 * Required table:
 *
 *   CREATE TABLE snapshots (
 *     snapshot_date      date    NOT NULL,
 *     product            text    NOT NULL,
 *     aum                numeric NOT NULL,  -- USD (supply × hardcoded NAV)
 *     holder_count       integer NOT NULL,
 *     top5_share         numeric NOT NULL,  -- fraction 0–1
 *     dormancy_share     numeric NOT NULL,  -- fraction 0–1
 *     transfer_volume_30d numeric NOT NULL, -- USD, non-mint/burn transfers
 *     PRIMARY KEY (snapshot_date, product)
 *   );
 */

import { getSupabase } from '@/src/lib/supabase/client'
import type { ProductSnapshot } from './types'

export async function writeSnapshots(snapshots: ProductSnapshot[]): Promise<void> {
  if (snapshots.length === 0) return
  const supabase = getSupabase()

  const rows = snapshots.map((s) => ({
    snapshot_date: s.snapshotDate,
    product: s.product,
    aum: s.aum,
    holder_count: s.holderCount,
    top5_share: s.top5Share,
    dormancy_share: s.dormancyShare,
    transfer_volume_30d: s.transferVolume30d,
  }))

  const { error } = await supabase
    .from('snapshots')
    .upsert(rows, { onConflict: 'snapshot_date,product' })

  if (error) throw new Error(`snapshots upsert failed: ${error.message}`)
}
