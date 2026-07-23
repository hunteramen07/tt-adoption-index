/**
 * Shared run-level page budget for chunked backfills.
 *
 * A single pool of request "pages" is drawn down across every in-progress
 * (fund, network) in one backfill invocation — NOT one budget per network. This
 * is the prerequisite for running more than one network in a slot without
 * blowing past rwa.xyz's 120/hr ceiling: two networks sharing an 80-page pool
 * still spend at most 80, whereas two independent 80-page budgets would spend
 * 160 and reliably trip a 429.
 *
 * Allocation policy: SEQUENTIAL-EXHAUST in config order. Each unit consumes
 * windows until the pool is dry, then the rest wait for the next slot. Chosen
 * over round-robin because (a) the per-network adaptive window span is a
 * locality signal that only pays off across consecutive same-network windows,
 * (b) a mid-backfill network is skipped by the nightly regardless, so driving
 * one network to `complete` (usable) beats advancing all of them halfway, and
 * (c) on a mid-run 429 the earliest network keeps maximal contiguous progress.
 */

/** Mutable, shared run-level page pool. `remaining` is decremented in place as
 *  each window is fetched, so every holder of the reference sees the draw-down. */
export type RunBudget = { remaining: number }

/**
 * Sequential-exhaust allocation over `items` drawing from a shared `budget`.
 * Runs each item in order; `runOne` does as much work as the remaining budget
 * allows (decrementing `budget.remaining` as it goes). Once the pool is dry, the
 * remaining items are left untouched for the next scheduled slot. Reused at both
 * the fund level (funds in a run) and the network level (networks in a fund) so
 * the same policy governs the whole run from one pool.
 */
export async function runSequentialUntilBudget<T>(
  items: readonly T[],
  budget: RunBudget,
  runOne: (item: T) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    if (budget.remaining <= 0) break
    await runOne(item)
  }
}
