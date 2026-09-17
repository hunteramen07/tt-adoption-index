/**
 * Unit tests for the backfill window-span sizing (shrink-on-failure, adaptive candidate,
 * exact-count preflight).
 * Run with: npm run test:backfill-span
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKFILL_MIN_SPAN_DAYS,
  BACKFILL_MAX_SPAN_DAYS,
  clampSpan,
  nextSpanFromDensity,
  halveSpanOnFailure,
  fitSpanToPages,
  sizeWindowByPreflight,
  addDaysStr,
  daysBetween,
  lagBandStart,
  syntheticAdvanceTarget,
  BACKFILL_TRAILING_LAG_DAYS,
} from './backfill-span.js'

describe('halveSpanOnFailure — shrink-on-failure (fail → halve → floor)', () => {
  test('halves an even span', () => {
    assert.equal(halveSpanOnFailure(30), 15)
    assert.equal(halveSpanOnFailure(60), 30)
  })

  test('floors the division on an odd span', () => {
    assert.equal(halveSpanOnFailure(15), 7) // floor(7.5)
    assert.equal(halveSpanOnFailure(7), 3)  // floor(3.5)
  })

  test('never drops below the 1-day floor', () => {
    assert.equal(halveSpanOnFailure(2), 1)
    assert.equal(halveSpanOnFailure(1), 1) // floor(0.5)=0 → clamped to MIN
    assert.equal(halveSpanOnFailure(BACKFILL_MIN_SPAN_DAYS), BACKFILL_MIN_SPAN_DAYS)
  })

  test('repeated halving converges to the floor and stays there', () => {
    let s = 30
    const seq: number[] = []
    for (let i = 0; i < 8; i++) { s = halveSpanOnFailure(s); seq.push(s) }
    assert.deepEqual(seq, [15, 7, 3, 1, 1, 1, 1, 1])
  })
})

describe('nextSpanFromDensity — adaptive sizing toward TARGET', () => {
  test('a dense window shrinks the span (90pg over 30d → 13d)', () => {
    assert.equal(nextSpanFromDensity(30, 90), 13) // round(40*30/90)
  })

  test('a sparse window grows the span, clamped to MAX (10pg over 30d)', () => {
    assert.equal(nextSpanFromDensity(30, 10), BACKFILL_MAX_SPAN_DAYS) // round(120) → clamp 60
  })

  test('an on-target window holds the span (40pg over 30d → 30d)', () => {
    assert.equal(nextSpanFromDensity(30, 40), 30)
  })

  test('an empty window (no density) grows bounded ×2, clamped', () => {
    assert.equal(nextSpanFromDensity(10, 0), 20)
    assert.equal(nextSpanFromDensity(40, 0), BACKFILL_MAX_SPAN_DAYS) // 80 → clamp 60
  })
})

describe('fitSpanToPages — proportional shrink to an exact count', () => {
  test('a window within the cap is left untouched', () => {
    assert.equal(fitSpanToPages(60, 40, 40), 60)
    assert.equal(fitSpanToPages(60, 6, 40), 60)
  })

  test('shrinks proportionally, floored (60d @ 97pg → cap 40 → 24d)', () => {
    assert.equal(fitSpanToPages(60, 97, 40), 24) // floor(60*40/97)
  })

  test('a low pool cap tightens further (60d @ 97pg → cap 9 → 5d)', () => {
    assert.equal(fitSpanToPages(60, 97, 9), 5) // floor(60*9/97)
  })

  test('always strictly smaller when over the cap, never below MIN', () => {
    assert.equal(fitSpanToPages(2, 3, 2), 1)   // floor(1.33)=1
    assert.equal(fitSpanToPages(3, 4, 3), 2)   // floor(2.25)=2
    assert.equal(fitSpanToPages(1, 50, 40), BACKFILL_MIN_SPAN_DAYS)
    assert.equal(fitSpanToPages(10, 11, 10), 9) // floor(9.09)=9 < 10
  })
})

describe('sizeWindowByPreflight — exact-count window sizing', () => {
  /** Fake count over a piecewise-constant pages/day history (the usdy:solana boundary:
   *  ~0.2 pg/day before 2024-09-25, ~1.6 pg/day after). */
  const tenthsPerDay = (day: string) => (day < '2024-09-25' ? 2 : 16) // integer tenths of a page
  const countPages = async (gte: string, lt: string) => {
    let tenths = 0
    for (let d = gte; d < lt; d = addDaysStr(d, 1)) tenths += tenthsPerDay(d)
    return Math.ceil(tenths / 10)
  }
  const today = '2026-09-15'

  test('the 2024-09-25 boundary: a 60d candidate (97pg) is shrunk until it fits 40', async () => {
    const r = await sizeWindowByPreflight({ frontierDay: '2024-09-25', todayDay: today, candidateSpanDays: 60, pageCap: 40, countPages })
    assert.ok(r.pages <= 40, `opened ${r.pages} pages`)
    assert.equal(r.overCap, false)
    assert.equal(r.spanDays, 25)                // 60d=96pg → floor(60*40/96)=25 → 25d=40pg ✓
    assert.equal(r.windowEnd, addDaysStr('2024-09-25', r.spanDays))
    assert.ok(r.probes >= 2 && r.probes <= 4, `probes ${r.probes}`)
  })

  test('a sparse window opens at the candidate in ONE probe', async () => {
    const r = await sizeWindowByPreflight({ frontierDay: '2024-08-27', todayDay: today, candidateSpanDays: 29, pageCap: 40, countPages })
    assert.deepEqual({ span: r.spanDays, pages: r.pages, probes: r.probes, over: r.overCap }, { span: 29, pages: 6, probes: 1, over: false })
  })

  test('the pool cap (min(TARGET, remaining)) is honoured, not just TARGET', async () => {
    const r = await sizeWindowByPreflight({ frontierDay: '2024-09-25', todayDay: today, candidateSpanDays: 60, pageCap: 9, countPages })
    assert.ok(r.pages <= 9, `opened ${r.pages} pages`)
    assert.equal(r.overCap, false)
  })

  test('truncates at today and scales from the days actually covered', async () => {
    const r = await sizeWindowByPreflight({ frontierDay: '2026-09-10', todayDay: today, candidateSpanDays: 60, pageCap: 40, countPages })
    assert.equal(r.windowEnd, today)
    assert.equal(r.spanDays, 5)
    assert.equal(r.probes, 1)
  })

  test('a single day over the cap is still opened (progress guaranteed), flagged overCap', async () => {
    const dense = async () => 120
    const r = await sizeWindowByPreflight({ frontierDay: '2025-01-01', todayDay: today, candidateSpanDays: 8, pageCap: 40, countPages: dense })
    assert.equal(r.spanDays, BACKFILL_MIN_SPAN_DAYS)
    assert.equal(r.overCap, true)
    assert.equal(r.windowEnd, '2025-01-02')
  })

  test('stops after maxProbes and opens the last probed span, flagged overCap', async () => {
    let calls = 0
    const stubborn = async () => { calls++; return 1000 } // never fits
    const r = await sizeWindowByPreflight({ frontierDay: '2025-01-01', todayDay: today, candidateSpanDays: 60, pageCap: 40, countPages: stubborn, maxProbes: 3 })
    assert.equal(calls, 3)
    assert.equal(r.probes, 3)
    assert.equal(r.overCap, true)
    assert.ok(r.spanDays < 60 && r.spanDays >= BACKFILL_MIN_SPAN_DAYS)
  })

  test('the candidate is clamped to [MIN, MAX] before the first probe', async () => {
    const seen: string[] = []
    const count = async (gte: string, lt: string) => { seen.push(`${gte}|${lt}`); return 1 }
    await sizeWindowByPreflight({ frontierDay: '2025-01-01', todayDay: today, candidateSpanDays: 500, pageCap: 40, countPages: count })
    assert.deepEqual(seen, [`2025-01-01|${addDaysStr('2025-01-01', BACKFILL_MAX_SPAN_DAYS)}`])
  })
})

describe('syntheticAdvanceTarget — empty windows never advance into the trailing lag band', () => {
  const today = '2026-07-25'
  test('lag band starts LAG days before today', () => {
    assert.equal(lagBandStart(today), addDaysStr(today, -BACKFILL_TRAILING_LAG_DAYS))
    assert.equal(lagBandStart(today, 3), '2026-07-22')
  })
  test('interior empty window advances to its end (gap-skipping unchanged)', () => {
    assert.equal(syntheticAdvanceTarget('2025-01-01', '2025-03-02', today), '2025-03-02')
    assert.equal(syntheticAdvanceTarget('2026-06-01', '2026-07-22', today), '2026-07-22') // ends exactly at the band start
  })
  test('a window straddling the band advances only to the band start', () => {
    assert.equal(syntheticAdvanceTarget('2026-06-20', '2026-07-25', today), '2026-07-22')
    assert.equal(syntheticAdvanceTarget('2026-07-21', '2026-07-23', today), '2026-07-22')
  })
  test('the usdy:arbitrum 07-24 case: a window wholly inside the band yields null (no synthetic cursor)', () => {
    assert.equal(syntheticAdvanceTarget('2026-07-24', '2026-07-25', today), null)
    assert.equal(syntheticAdvanceTarget('2026-07-22', '2026-07-25', today), null) // frontier at the band start
  })
  test('lagDays is a parameter', () => {
    assert.equal(syntheticAdvanceTarget('2026-07-24', '2026-07-25', today, 0), '2026-07-25')
    assert.equal(syntheticAdvanceTarget('2026-07-10', '2026-07-25', today, 14), '2026-07-11')
  })
})

describe('daysBetween / addDaysStr', () => {
  test('round-trip across a month boundary and a leap day', () => {
    assert.equal(addDaysStr('2024-02-28', 2), '2024-03-01')
    assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2)
    assert.equal(daysBetween('2024-09-25', '2024-11-24'), 60)
    assert.equal(daysBetween('2026-09-15', '2026-09-10'), -5)
  })
})

describe('clampSpan', () => {
  test('clamps to [MIN, MAX]', () => {
    assert.equal(clampSpan(0), BACKFILL_MIN_SPAN_DAYS)
    assert.equal(clampSpan(1000), BACKFILL_MAX_SPAN_DAYS)
    assert.equal(clampSpan(20), 20)
  })
})
