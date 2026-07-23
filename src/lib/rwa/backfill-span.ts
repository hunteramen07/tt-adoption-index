/**
 * Adaptive window-span sizing for the chunked first-backfill (pure, unit-testable).
 *
 * The backfill walks a network's history in day-bounded windows, sizing each toward
 * ~TARGET pages from the last window's observed density. Two hazards this module
 * guards, both of which froze USDY Solana in a deterministic 429 loop at the
 * sparse→dense history boundary (2025-11-13):
 *   • a window sized from sparse-era density overshoots badly when the dense era
 *     begins — halveSpanOnFailure shrinks it after a failure so the next attempt is
 *     smaller (the span is persisted across slots by the caller, since a 429 ends the
 *     run — this is not an in-run retry);
 *   • nothing bounded pages WITHIN a window (the run pool only gates between windows),
 *     so a single window could exceed the whole pool / the 120/hr limit —
 *     capSpanByBudget never opens a window estimated to exceed min(TARGET, budget).
 *
 * Constants live here so the sizing math is testable offline; the persisted-span I/O
 * and the loop that uses these stay in scripts/classify.ts.
 */

/** Adaptive window target: size each window toward ~this many pages. */
export const BACKFILL_TARGET_PAGES = 40
export const BACKFILL_MIN_SPAN_DAYS = 1
export const BACKFILL_MAX_SPAN_DAYS = 60
export const BACKFILL_INITIAL_SPAN_DAYS = 30

/** Clamp a span to [MIN, MAX] days. */
export const clampSpan = (n: number): number =>
  Math.max(BACKFILL_MIN_SPAN_DAYS, Math.min(BACKFILL_MAX_SPAN_DAYS, n))

/**
 * Next window span from the just-completed window's density (pages over spanDays),
 * aimed at ~targetPages, clamped to [MIN, MAX]. An empty window (0 pages) carries no
 * density signal, so grow (bounded ×2) to skip sparse gaps. This is the learning
 * signal — feed it the MOST RECENTLY completed window so it adapts as density rises.
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
 * floored at MIN (1 day). Used when a window fails (429 / timeout) — the caller
 * persists the result so the NEXT slot retries the smaller window (a 429 still drains
 * the pool and ends the run; this is not an in-run retry).
 */
export function halveSpanOnFailure(spanDays: number): number {
  return Math.max(BACKFILL_MIN_SPAN_DAYS, Math.floor(spanDays / 2))
}

/**
 * Cap a candidate span so its ESTIMATED pages never exceed min(targetPages,
 * budgetRemaining), using the last completed window's density (pages/day). Never open
 * a window the remaining pool can't afford. Floors at MIN so some progress is always
 * made. With no density signal yet (lastPages ≤ 0, e.g. the first window of a run or
 * an empty prior window) the candidate is returned unchanged — there's nothing to
 * estimate against, and the resumed span was already density- or failure-sized.
 */
export function capSpanByBudget(
  candidateSpanDays: number,
  lastSpanDays: number,
  lastPages: number,
  budgetRemaining: number,
  targetPages: number = BACKFILL_TARGET_PAGES,
): number {
  if (lastPages <= 0 || lastSpanDays <= 0) return candidateSpanDays
  const pageCap = Math.min(targetPages, Math.max(0, budgetRemaining))
  const densityPagesPerDay = lastPages / lastSpanDays
  const maxSpanForCap = Math.floor(pageCap / densityPagesPerDay)
  return Math.max(BACKFILL_MIN_SPAN_DAYS, Math.min(candidateSpanDays, maxSpanForCap))
}
