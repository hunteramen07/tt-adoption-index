/**
 * Window-span sizing for the chunked first-backfill (pure, unit-testable).
 *
 * The backfill walks a network's history in day-bounded windows. A window's cost is
 * its page count, and the run has two hard ceilings on that: the shared per-run page
 * pool (rwa.xyz's 120/hr) and — the one that actually bound in practice — wall-clock,
 * because a /v4/transactions page takes ~8-16 s, not the 600 ms throttle. A single
 * oversized window at a density jump could not finish inside the job timeout, and a
 * timeout kill is a SIGTERM that no catch block sees, so the identical window was
 * re-opened every slot (usdy:solana, 2024-09-25: 6 pages for the prior 29 days, then
 * 97 pages for the next 60).
 *
 * Two mechanisms, both here so the math is testable offline:
 *   • sizeWindowByPreflight — the window is sized from an EXACT count (one perPage=1
 *     request per probe) rather than extrapolated from the last window's density. It
 *     shrinks the candidate span proportionally until the counted pages fit the cap,
 *     so a sparse→dense boundary can never open a window larger than the cap. This is
 *     what removes the boundary trap permanently, not just at one cursor.
 *   • halveSpanOnFailure — the fallback for anything the preflight cannot see (a 429,
 *     a timeout, an RPC outage, a job kill). The caller persists the halved span
 *     BEFORE opening the window, so a kill leaves the halved value behind.
 *
 * nextSpanFromDensity still proposes the NEXT candidate from the window just completed
 * (now from its exact page count); the preflight is what decides whether that
 * candidate is safe to open. Constants live here; the persisted-span I/O and the loop
 * that uses these stay in scripts/classify.ts.
 */

/** Adaptive window target: size each window toward ~this many pages. */
export const BACKFILL_TARGET_PAGES = 40
export const BACKFILL_MIN_SPAN_DAYS = 1
export const BACKFILL_MAX_SPAN_DAYS = 60
export const BACKFILL_INITIAL_SPAN_DAYS = 30
/** Preflight count requests one window may spend before opening as-is. Each probe is
 *  a real rwa.xyz request (charged to the run pool by the caller). */
export const BACKFILL_MAX_PREFLIGHT_PROBES = 4
/**
 * Trailing lag band, in days before today, inside which an EMPTY window is never
 * trusted. rwa.xyz indexes with a lag (measured ≥ 8 h on usdy:arbitrum: a 450,000
 * token-mint at 2026-07-24 21:43 UTC was absent from the feed at 05:50 next morning),
 * so a window that ends at/near today can be empty because its records do not exist
 * YET. Advancing a synthetic cursor past such a window skips those records forever —
 * the nightly then fetches `gte cursor` and never sees them. This constant only has
 * to cover the ordinary indexing delay; the completion check (Σ balances vs
 * /v4/assets supply, in scripts/classify.ts) is what catches a longer lag.
 */
export const BACKFILL_TRAILING_LAG_DAYS = 3

/** Clamp a span to [MIN, MAX] days. */
export const clampSpan = (n: number): number =>
  Math.max(BACKFILL_MIN_SPAN_DAYS, Math.min(BACKFILL_MAX_SPAN_DAYS, n))

/**
 * Next window span from the just-completed window's density (pages over spanDays),
 * aimed at ~targetPages, clamped to [MIN, MAX]. An empty window (0 pages) carries no
 * density signal, so grow (bounded ×2) to skip sparse gaps. This proposes the next
 * CANDIDATE only — sizeWindowByPreflight checks it against an exact count before it
 * is opened, so growing into a dense era is safe.
 */
export function nextSpanFromDensity(
  spanDays: number,
  pages: number,
  targetPages: number = BACKFILL_TARGET_PAGES,
): number {
  return pages > 0
    ? clampSpan(Math.round((targetPages * spanDays) / pages))
    : clampSpan(spanDays * 2)
}

/**
 * Shrink-on-failure: halve the span so the next attempt opens a smaller window,
 * floored at MIN (1 day). Used when a window fails for a reason the preflight cannot
 * anticipate (429 / timeout / chain-RPC outage) — and, because the caller persists it
 * BEFORE the fetch, when the process is killed mid-window (this is not an in-run retry;
 * the next slot retries the smaller window).
 */
export function halveSpanOnFailure(spanDays: number): number {
  return Math.max(BACKFILL_MIN_SPAN_DAYS, Math.floor(spanDays / 2))
}

/**
 * Shrink `spanDays` so that a window counted at `pages` fits `pageCap`, assuming
 * uniform density inside the window (proportional scaling, floored). Always returns a
 * STRICTLY smaller span when over the cap (so a probe loop makes progress) and never
 * less than MIN. A window already within the cap is returned unchanged.
 */
export function fitSpanToPages(spanDays: number, pages: number, pageCap: number): number {
  if (pages <= pageCap) return spanDays
  const cap = Math.max(0, pageCap)
  const scaled = Math.floor((spanDays * cap) / pages)
  return Math.max(BACKFILL_MIN_SPAN_DAYS, Math.min(scaled, spanDays - 1))
}

/** Add n days to a 'YYYY-MM-DD' day string (UTC). */
export function addDaysStr(dayStr: string, n: number): string {
  const d = new Date(`${dayStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Whole days from day a to day b ('YYYY-MM-DD', UTC); negative if b < a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000)
}

export interface PreflightInput {
  /** Window start day (inclusive), 'YYYY-MM-DD'. */
  frontierDay: string
  /** Windows never extend past this day (exclusive bound is min(frontier+span, today)). */
  todayDay: string
  /** Starting candidate span, days (the persisted / learned value). Clamped here. */
  candidateSpanDays: number
  /** Maximum pages the window may cost: min(TARGET, pool remaining). */
  pageCap: number
  /** Exact page count of [gteDay, ltDay) — one perPage=1 request. */
  countPages: (gteDay: string, ltDay: string) => Promise<number>
  maxProbes?: number
}

export interface PreflightResult {
  spanDays: number
  windowEnd: string
  /** Counted pages of the window that will be opened. */
  pages: number
  /** Count requests spent — the caller charges these to the run pool. */
  probes: number
  /** True when the window is opened over the cap: MIN span or probes exhausted. */
  overCap: boolean
}

/**
 * Size a window from exact counts. Starting at the candidate span, count the window;
 * while it exceeds `pageCap`, shrink proportionally and re-count, up to `maxProbes`
 * requests. The window is ALWAYS opened — at the 1-day floor even if that single day
 * is over the cap, and at the last probed span if probes run out — because refusing
 * to open would stall the cursor exactly like the failure loop this replaces. The
 * caller's job timeout is the backstop for an over-cap window, and `overCap` lets it
 * log that it is knowingly opening one.
 */
export async function sizeWindowByPreflight(input: PreflightInput): Promise<PreflightResult> {
  const maxProbes = input.maxProbes ?? BACKFILL_MAX_PREFLIGHT_PROBES
  let spanDays = clampSpan(input.candidateSpanDays)
  let probes = 0
  for (;;) {
    let windowEnd = addDaysStr(input.frontierDay, spanDays)
    if (windowEnd > input.todayDay) windowEnd = input.todayDay
    // Scale from the days the window actually covers (it may be truncated at today),
    // so the proportional shrink measures the density that was counted.
    const effectiveDays = Math.max(BACKFILL_MIN_SPAN_DAYS, daysBetween(input.frontierDay, windowEnd))
    const pages = await input.countPages(input.frontierDay, windowEnd)
    probes++
    if (pages <= input.pageCap) return { spanDays: effectiveDays, windowEnd, pages, probes, overCap: false }
    const shrunk = fitSpanToPages(effectiveDays, pages, input.pageCap)
    if (shrunk === effectiveDays || effectiveDays <= BACKFILL_MIN_SPAN_DAYS || probes >= maxProbes) {
      return { spanDays: effectiveDays, windowEnd, pages, probes, overCap: true }
    }
    spanDays = shrunk
  }
}

/** First day of the trailing lag band: today − lagDays ('YYYY-MM-DD'). */
export const lagBandStart = (todayDay: string, lagDays: number = BACKFILL_TRAILING_LAG_DAYS): string =>
  addDaysStr(todayDay, -lagDays)

/**
 * Where an EMPTY window [frontierDay, windowEnd) may advance a synthetic cursor to:
 *   • windowEnd, when the whole window is interior (ends at or before the lag band);
 *   • the lag-band start, when the window straddles it (advance up to, never into it);
 *   • null, when the window lies wholly inside the band — no synthetic cursor at all,
 *     the caller leaves the cursor at the last real record and treats the network as
 *     caught up to the feed's current edge (subject to the completion check).
 * A null return is the only outcome that could have saved usdy:arbitrum's 07-24 mint.
 */
export function syntheticAdvanceTarget(
  frontierDay: string,
  windowEnd: string,
  todayDay: string,
  lagDays: number = BACKFILL_TRAILING_LAG_DAYS,
): string | null {
  const band = lagBandStart(todayDay, lagDays)
  if (windowEnd <= band) return windowEnd
  if (frontierDay < band) return band
  return null
}
