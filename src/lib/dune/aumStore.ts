/**
 * Supabase `aum_history` — the persisted Dune supply/AUM series (query 7696914).
 *
 *   CREATE TABLE aum_history (
 *     contract_address text        NOT NULL,  -- lowercase Ethereum token address
 *     day              date        NOT NULL,
 *     supply_raw       numeric     NOT NULL,  -- raw integer supply at end of day
 *     execution_id     text        NOT NULL,  -- the Dune execution the row came from
 *     executed_at      timestamptz NOT NULL,  -- that execution's execution_ended_at
 *     fetched_at       timestamptz NOT NULL DEFAULT now(),
 *     PRIMARY KEY (contract_address, day)
 *   );
 *   (supabase/migrations/20261019120000_create_aum_history.sql)
 *
 * Written only by scripts/refresh-dune.ts (nightly, recent rows). Read by the
 * homepage (supplyHistory.ts) and the monthly index backfill. Neither ever
 * reads Dune directly.
 */

import { getSupabase } from '@/src/lib/supabase/client'
import type { AumHistoryRow } from './aumSeries'

export const AUM_HISTORY_TABLE = 'aum_history'

export interface PersistedAumHistory {
  rows: AumHistoryRow[]
  /** execution_id of the newest execution present (by executed_at); null when empty. */
  executionId: string | null
  /** MAX(executed_at) — what coverage is computed from; null when empty. */
  executedAt: string | null
  /** MAX(fetched_at) — when the refresh last wrote; null when empty. */
  fetchedAt: string | null
}

export interface AumHistoryUpsertRow {
  contract_address: string
  day: string
  supply_raw: string
  execution_id: string
  executed_at: string
  fetched_at: string
}

/**
 * Read the whole persisted series, paged (PostgREST caps a SELECT at ~1000 rows).
 * supply_raw is read as text so a 27-digit integer never passes through a JS
 * float. Throws on any error — a missing table is a setup fault, not "no data".
 */
export async function loadAumHistory(): Promise<PersistedAumHistory> {
  const supabase = getSupabase()
  const rows: AumHistoryRow[] = []
  let executionId: string | null = null
  let executedAt: string | null = null
  let fetchedAt: string | null = null
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(AUM_HISTORY_TABLE)
      .select('contract_address, day, supply_raw::text, execution_id, executed_at, fetched_at')
      .order('contract_address', { ascending: true })
      .order('day', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      throw new Error(
        `${AUM_HISTORY_TABLE} read failed: ${error.message}` +
          (error.message.includes('does not exist') || error.code === '42P01'
            ? ' — apply supabase/migrations/20261019120000_create_aum_history.sql'
            : '')
      )
    }
    for (const r of data ?? []) {
      rows.push({
        contractAddress: String(r.contract_address).toLowerCase(),
        day: String(r.day).slice(0, 10),
        supplyRaw: String(r.supply_raw),
      })
      const ex = String(r.executed_at)
      if (executedAt === null || ex > executedAt) {
        executedAt = ex
        executionId = String(r.execution_id)
      }
      const f = String(r.fetched_at)
      if (fetchedAt === null || f > fetchedAt) fetchedAt = f
    }
    if (!data || data.length < PAGE) break
  }
  return { rows, executionId, executedAt, fetchedAt }
}

/** The latest persisted day across all tokens, or null when the table is empty. */
export async function latestPersistedDay(): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from(AUM_HISTORY_TABLE)
    .select('day')
    .order('day', { ascending: false })
    .limit(1)
  if (error) throw new Error(`${AUM_HISTORY_TABLE} read failed: ${error.message}`)
  const day = data?.[0]?.day
  return day ? String(day).slice(0, 10) : null
}

/** Upsert rows on (contract_address, day) in batches. */
export async function upsertAumHistory(rows: AumHistoryUpsertRow[]): Promise<void> {
  if (rows.length === 0) return
  const supabase = getSupabase()
  const BATCH = 500
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const { error } = await supabase
      .from(AUM_HISTORY_TABLE)
      .upsert(batch, { onConflict: 'contract_address,day' })
    if (error) throw new Error(`${AUM_HISTORY_TABLE} upsert failed (batch ${i}): ${error.message}`)
  }
}
