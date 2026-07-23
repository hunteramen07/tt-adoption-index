/**
 * Unit tests for the shared backfill run-budget allocation.
 * Run with: npm run test:backfill-budget
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runSequentialUntilBudget, type RunBudget } from './backfill-budget.js'

/** Build a runner that records the items it processed and draws `cost(item)`
 *  pages from the shared pool per item (mirrors a network spending `pages`). */
function makeRunner(cost: (item: string) => number) {
  const ran: string[] = []
  const runOne = async (budget: RunBudget, item: string) => {
    ran.push(item)
    budget.remaining -= cost(item)
  }
  return { ran, runOne }
}

describe('runSequentialUntilBudget — sequential-exhaust over a shared pool', () => {
  test('runs every item in config order when the pool is ample', async () => {
    const budget: RunBudget = { remaining: 80 }
    const { ran, runOne } = makeRunner(() => 10)
    await runSequentialUntilBudget(['a', 'b', 'c'], budget, (i) => runOne(budget, i))
    assert.deepEqual(ran, ['a', 'b', 'c'])
    assert.equal(budget.remaining, 50) // 80 − 3×10, one shared pool (not reset per item)
  })

  test('stops once the shared pool is dry — remaining items wait for next slot', async () => {
    // Each item costs 40. a:80→40, b:40→0, c: pool dry at start ⇒ skipped.
    const budget: RunBudget = { remaining: 80 }
    const { ran, runOne } = makeRunner(() => 40)
    await runSequentialUntilBudget(['a', 'b', 'c'], budget, (i) => runOne(budget, i))
    assert.deepEqual(ran, ['a', 'b']) // c never ran
    assert.equal(budget.remaining, 0)
  })

  test('draw-down is cumulative across items, NOT per-item budgets', async () => {
    // If each item had its own 80, all three would run; with one shared pool of 80
    // and cost 50 each, a:80→30, b:30→-20, c: dry ⇒ skipped.
    const budget: RunBudget = { remaining: 80 }
    const { ran, runOne } = makeRunner(() => 50)
    await runSequentialUntilBudget(['a', 'b', 'c'], budget, (i) => runOne(budget, i))
    assert.deepEqual(ran, ['a', 'b'])
    assert.ok(budget.remaining < 0) // last window overran the pool slightly, as in real windows
  })

  test('a cheap (completing) item leaves the remainder for the next item', async () => {
    // a completes cheaply (10), so b still runs from the shared remainder.
    const budget: RunBudget = { remaining: 80 }
    const cost: Record<string, number> = { a: 10, b: 30 }
    const { ran, runOne } = makeRunner((i) => cost[i])
    await runSequentialUntilBudget(['a', 'b'], budget, (i) => runOne(budget, i))
    assert.deepEqual(ran, ['a', 'b'])
    assert.equal(budget.remaining, 40) // 80 − 10 − 30
  })

  test('draining the pool to zero (the 429 mechanism) ends the run immediately', async () => {
    // Models the 429 path: the runner zeroes the pool on the offending item, and
    // the helper then skips every remaining item — the whole run ends gracefully.
    const budget: RunBudget = { remaining: 80 }
    const ran: string[] = []
    await runSequentialUntilBudget(['a', 'b', 'c', 'd'], budget, async (item) => {
      ran.push(item)
      if (item === 'b') budget.remaining = 0 // simulate a 429 draining the pool
      else budget.remaining -= 5
    })
    assert.deepEqual(ran, ['a', 'b']) // c and d skipped after the drain
    assert.equal(budget.remaining, 0)
  })

  test('an already-dry pool runs nothing', async () => {
    const budget: RunBudget = { remaining: 0 }
    const { ran, runOne } = makeRunner(() => 10)
    await runSequentialUntilBudget(['a', 'b'], budget, (i) => runOne(budget, i))
    assert.deepEqual(ran, [])
  })

  test('empty item list is a clean no-op', async () => {
    const budget: RunBudget = { remaining: 80 }
    let calls = 0
    await runSequentialUntilBudget([], budget, async () => { calls++ })
    assert.equal(calls, 0)
    assert.equal(budget.remaining, 80)
  })
})
