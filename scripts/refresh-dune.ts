/**
 * npm run refresh-dune [-- --full] [-- --no-execute] [-- --dry-run]
 *
 * Executes the supply/AUM Dune query (7696914) and persists the RECENT rows into
 * Supabase `aum_history`. The homepage and the monthly index backfill read that
 * table only — never Dune — so Dune's per-cycle datapoint quota is spent once a
 * night on about a week of rows instead of on every page view. (The live reads
 * exhausted the quota on 2026-09-24: 26 straight nightly failures, the homepage
 * AUM chart dark, and the 2026-10-01 monthly reading never written.)
 *
 * Steps:
 *   1. POST /query/7696914/execute, then poll /execution/{id}/status until it
 *      finishes (status polls are free). --no-execute skips this and reads the
 *      latest SAVED execution instead (no credits spent on a run).
 *   2. Read rows with `filters=day >= <latest persisted day − 7>` — the 7-day
 *      overlap lets a late-landing Dune row be corrected by the upsert — paged
 *      1,000 at a time, sorted by day. Datapoints are charged on rows RETURNED,
 *      so a nightly read is ~5 tokens × ~8 days × 3 columns ≈ 120 datapoints.
 *      --full drops the filter for the one-time initial load (~12,200 datapoints).
 *   3. Upsert on (contract_address, day), stamping every row with the execution
 *      id and its execution_ended_at — coverage for lookupAum is derived from the
 *      latter (src/lib/dune/aumSeries.ts).
 *
 * Refuses to run incrementally against an EMPTY table (pass --full), and stops on
 * any Dune error — a 402 means the quota is still exhausted; nothing is written.
 *
 * Env: DUNE_API_KEY, NEXT_PUBLIC_SUPABASE_URL and a Supabase key.
 *
 * Flags:
 *   --full         Read the whole result set (initial load, or a rebuild).
 *   --no-execute   Do not trigger a new execution; read the latest saved one.
 *   --dry-run      Fetch and summarise; write nothing to Supabase.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import {
  DuneHttpError,
  duneExecuteQuery,
  duneGetExecutionResults,
  duneGetExecutionStatus,
  duneGetLatestResults,
} from '@/src/lib/dune/client'
import type { DuneResultsPage, DuneSupplyRow } from '@/src/lib/dune/client'
import { overlapSince } from '@/src/lib/dune/aumSeries'
import { latestPersistedDay, upsertAumHistory } from '@/src/lib/dune/aumStore'
import type { AumHistoryUpsertRow } from '@/src/lib/dune/aumStore'

export const DUNE_SUPPLY_QUERY_ID = 7696914
/** Days re-read behind the latest persisted day on an incremental refresh. */
export const REFRESH_OVERLAP_DAYS = 7
const PAGE = 1000
const POLL_MS = 15_000
const POLL_TIMEOUT_MS = 20 * 60_000

const full = process.argv.includes('--full')
const noExecute = process.argv.includes('--no-execute')
const dryRun = process.argv.includes('--dry-run')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function executeAndWait(): Promise<{ executionId: string; executedAt: string }> {
  const { execution_id } = await duneExecuteQuery(DUNE_SUPPLY_QUERY_ID)
  console.log(`[refresh-dune] execution ${execution_id} started; polling every ${POLL_MS / 1000}s…`)
  const t0 = Date.now()
  for (;;) {
    const s = await duneGetExecutionStatus(execution_id)
    if (s.is_execution_finished) {
      if (s.state !== 'QUERY_STATE_COMPLETED') throw new Error(`[refresh-dune] execution ${execution_id} ended in ${s.state}`)
      if (!s.execution_ended_at) throw new Error(`[refresh-dune] execution ${execution_id} completed without execution_ended_at`)
      console.log(`[refresh-dune] completed at ${s.execution_ended_at} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
      return { executionId: execution_id, executedAt: s.execution_ended_at }
    }
    if (Date.now() - t0 > POLL_TIMEOUT_MS) throw new Error(`[refresh-dune] execution ${execution_id} still ${s.state} after ${POLL_TIMEOUT_MS / 60_000} min`)
    await sleep(POLL_MS)
  }
}

async function latestSaved(): Promise<{ executionId: string; executedAt: string }> {
  const page = await duneGetLatestResults(DUNE_SUPPLY_QUERY_ID, { limit: 1, columns: ['day'] })
  if (page.state !== 'QUERY_STATE_COMPLETED' || !page.execution_ended_at) {
    throw new Error(`[refresh-dune] latest saved execution is ${page.state} (ended ${page.execution_ended_at ?? 'n/a'})`)
  }
  console.log(`[refresh-dune] --no-execute: using saved execution ${page.execution_id} (ended ${page.execution_ended_at})`)
  return { executionId: page.execution_id, executedAt: page.execution_ended_at }
}

/** Normalise a Dune row for the upsert; the address is lowercased, the day truncated. */
export function toUpsertRow(r: DuneSupplyRow, executionId: string, executedAt: string, fetchedAt: string): AumHistoryUpsertRow {
  return {
    contract_address: r.contract_address.toLowerCase(),
    day: r.day.slice(0, 10),
    supply_raw: String(r.supply_raw),
    execution_id: executionId,
    executed_at: executedAt,
    fetched_at: fetchedAt,
  }
}

async function main() {
  console.log(`[refresh-dune] query ${DUNE_SUPPLY_QUERY_ID}${full ? ' — FULL load' : ''}${noExecute ? ' — no execute' : ''}${dryRun ? ' — dry-run' : ''}`)

  // Decide the read window BEFORE spending anything on Dune.
  let filters: string | undefined
  if (full) {
    filters = undefined
  } else {
    const latest = await latestPersistedDay()
    if (latest === null) {
      throw new Error('[refresh-dune] aum_history is empty — pass --full for the one-time initial load (~12,200 datapoints)')
    }
    filters = `day >= '${overlapSince(latest, REFRESH_OVERLAP_DAYS)}'`
    console.log(`[refresh-dune] latest persisted day ${latest}; reading ${filters}`)
  }

  const { executionId, executedAt } = noExecute ? await latestSaved() : await executeAndWait()
  const fetchedAt = new Date().toISOString()

  // Page through the (filtered) rows. Datapoints are charged per row returned.
  const rows: AumHistoryUpsertRow[] = []
  let datapoints = 0
  for (let offset = 0; ; ) {
    const page: DuneResultsPage = await duneGetExecutionResults(executionId, { filters, sortBy: 'day', limit: PAGE, offset })
    if (!page.result) throw new Error(`[refresh-dune] execution ${executionId} returned no result (state ${page.state})`)
    for (const r of page.result.rows) rows.push(toUpsertRow(r, executionId, executedAt, fetchedAt))
    datapoints += page.result.metadata.datapoint_count
    console.log(`[refresh-dune] page @${offset}: ${page.result.rows.length} rows (${page.result.metadata.datapoint_count} datapoints; ${page.result.metadata.total_row_count} total)`)
    if (page.next_offset === undefined || page.result.rows.length < PAGE) break
    offset = page.next_offset
  }

  const days = rows.map((r) => r.day).sort()
  const byAddress = new Map<string, number>()
  for (const r of rows) byAddress.set(r.contract_address, (byAddress.get(r.contract_address) ?? 0) + 1)
  console.log(`[refresh-dune] ${rows.length} rows, ${datapoints} datapoints charged, days ${days[0] ?? '—'} → ${days.at(-1) ?? '—'}`)
  for (const [addr, n] of byAddress) console.log(`  ${addr}: ${n} rows`)

  if (rows.length === 0) throw new Error('[refresh-dune] zero rows returned — not writing (a filtered read that returns nothing is a fault, not a quiet week)')

  if (dryRun) {
    console.log('[refresh-dune] dry-run — nothing written')
    return
  }
  await upsertAumHistory(rows)
  console.log(`[refresh-dune] upserted ${rows.length} rows into aum_history (execution ${executionId}, executed ${executedAt})`)
}

main().catch((err) => {
  if (err instanceof DuneHttpError && err.isQuotaExceeded) {
    console.error('\n[refresh-dune] Dune datapoint quota still exhausted (HTTP 402) — nothing written:', err.body.slice(0, 200))
  } else {
    console.error('\n[refresh-dune] fatal error:', err)
  }
  process.exit(1)
})
