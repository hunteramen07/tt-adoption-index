/**
 * Cursor-age tripwire — catches a (fund, network) whose aggregate row keeps getting a
 * fresh classified_at over state that stopped advancing.
 *
 * WHY. classified_at is the wall-clock time of the write, not a measure of the data
 * behind it. usdy:ethereum carried seven weeks of fresh timestamps over a cursor
 * frozen at 2026-07-23 (2,980 transactions behind by 09-14; arbitrum 11,579; sei
 * 75,589; stellar 70,945). The cause was STRUCTURAL, not slowness: backfill_complete
 * is a one-way hand-off to a nightly that only runs a fund once its slug is in
 * RWA_MULTICHAIN_SLUGS, so between completion and cutover no code path touches the
 * cursor at all (_local/usdy-cutover-runbook.md). Two checks, because those are two
 * different failures:
 *
 *   1. ORPHANED — a completed backfill on a fund the nightly does not run (or on a
 *      network no longer in config). Nothing will ever advance it. Pure config-vs-
 *      table; fires every night until cutover, which is the point.
 *   2. STALE UNDER ACTIVITY — the nightly DID run this network, but its cursor is
 *      older than CURSOR_STALE_DAYS while rwa.xyz's own aggregates for it (supply or
 *      holder count, from /v4/assets, which the nightly already fetches) moved in
 *      the last 7 days. A quiet network — dividend-only chains, dust deployments —
 *      is not flagged on age alone until CURSOR_STALE_QUIET_DAYS, a sanity ceiling.
 *
 * Both persist to reconciliation_history with outcome 'cursor_stale' (free-text
 * column, no migration), two columns overloaded: deviation_pct = cursor age in DAYS,
 * threshold_pct = the threshold it tripped in DAYS. Pure; the caller does the I/O.
 */

/** Cursor age above which a network with recent feed activity is stale. */
export const CURSOR_STALE_DAYS = 3
/** Cursor age above which even a quiet network is reported. */
export const CURSOR_STALE_QUIET_DAYS = 14

const DAY_MS = 86_400_000

export interface CursorAgeInput {
  /** fetch_cursor.last_tx_timestamp (ISO), or null when the row has none. */
  lastTxTimestamp: string | null
  /** Evaluation time, ms since epoch. */
  nowMs: number
  /** rwa.xyz's 7-day movement for the network; null when it reported nothing. */
  activity: { supplyMoved: boolean; holdersMoved: boolean } | null
  staleDays?: number
  quietDays?: number
}

export interface CursorAgeResult {
  stale: boolean
  /** Age in days, or null with no cursor. */
  ageDays: number | null
  /** The threshold that applied (staleDays with activity, quietDays without). */
  thresholdDays: number
  reason: string
}

/** Pure — no I/O. */
export function evaluateCursorAge(input: CursorAgeInput): CursorAgeResult {
  const staleDays = input.staleDays ?? CURSOR_STALE_DAYS
  const quietDays = input.quietDays ?? CURSOR_STALE_QUIET_DAYS
  if (!input.lastTxTimestamp) {
    return { stale: false, ageDays: null, thresholdDays: staleDays, reason: 'no cursor (never fetched) — not an age question' }
  }
  const ms = Date.parse(input.lastTxTimestamp)
  if (!Number.isFinite(ms)) {
    return { stale: false, ageDays: null, thresholdDays: staleDays, reason: `unparseable cursor timestamp ${input.lastTxTimestamp}` }
  }
  const ageDays = Math.max(0, (input.nowMs - ms) / DAY_MS)
  const active = input.activity != null && (input.activity.supplyMoved || input.activity.holdersMoved)
  if (active && ageDays > staleDays) {
    const what = [input.activity!.supplyMoved ? 'supply' : null, input.activity!.holdersMoved ? 'holder count' : null].filter(Boolean).join(' and ')
    return {
      stale: true,
      ageDays,
      thresholdDays: staleDays,
      reason: `cursor is ${ageDays.toFixed(1)} days old while rwa.xyz reports ${what} moved in the last 7 days — frozen, not quiet`,
    }
  }
  if (ageDays > quietDays) {
    return {
      stale: true,
      ageDays,
      thresholdDays: quietDays,
      reason: `cursor is ${ageDays.toFixed(1)} days old${input.activity == null ? ' (no activity signal from /v4/assets)' : ' with no 7-day movement on rwa.xyz'} — past the quiet-network ceiling`,
    }
  }
  return {
    stale: false,
    ageDays,
    thresholdDays: active ? staleDays : quietDays,
    reason: active ? `cursor ${ageDays.toFixed(1)} days old, within ${staleDays} days of feed activity` : `cursor ${ageDays.toFixed(1)} days old, network quiet`,
  }
}

export interface FetchCursorRow {
  product_slug: string
  network: string
  backfill_complete: boolean | null
  last_tx_timestamp: string | null
}

export interface OrphanedCursor {
  productSlug: string
  network: string
  lastTxTimestamp: string | null
  ageDays: number | null
  reason: string
}

/**
 * Completed cursors nothing will ever advance: the fund is not on the nightly's
 * multi-chain path, or the network is no longer configured for it. Pure.
 */
export function findOrphanedCursors(
  rows: readonly FetchCursorRow[],
  opts: {
    nowMs: number
    /** Funds the nightly runs through the rwa.xyz path (RWA_MULTICHAIN_SLUGS). */
    multichainSlugs: ReadonlySet<string>
    /** Configured observable network slugs per fund (from products.ts). */
    configuredNetworks: ReadonlyMap<string, ReadonlySet<string>>
  }
): OrphanedCursor[] {
  const out: OrphanedCursor[] = []
  for (const r of rows) {
    if (r.backfill_complete === false) continue // in progress: the backfill owns it
    const configured = opts.configuredNetworks.get(r.product_slug)?.has(r.network) ?? false
    const onNightly = opts.multichainSlugs.has(r.product_slug)
    let reason: string | null = null
    if (!configured) reason = `network is not configured (or not observable) for this fund — the cursor is unreachable`
    else if (!onNightly) reason = `backfill complete but the fund is not in RWA_MULTICHAIN_SLUGS — no code path advances this cursor until cutover`
    if (!reason) continue
    const ms = r.last_tx_timestamp ? Date.parse(r.last_tx_timestamp) : NaN
    out.push({
      productSlug: r.product_slug,
      network: r.network,
      lastTxTimestamp: r.last_tx_timestamp,
      ageDays: Number.isFinite(ms) ? Math.max(0, (opts.nowMs - ms) / DAY_MS) : null,
      reason,
    })
  }
  return out
}
