/**
 * Unit tests for the backfill window-span sizing (shrink-on-failure, adaptive, budget cap).
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
  capSpanByBudget,
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

describe('capSpanByBudget — never open more than min(TARGET, budget) pages', () => {
  test('ample budget caps at the TARGET-equivalent span (density 3/day)', () => {
    // candidate 20d (~60pg), budget 80 → cap min(40,80)=40pg → floor(40/3)=13d
    assert.equal(capSpanByBudget(20, 15, 45, 80), 13)
  })

  test('low remaining budget tightens the cap below TARGET', () => {
    // density 3/day, budget 9 → cap min(40,9)=9pg → floor(9/3)=3d
    assert.equal(capSpanByBudget(20, 15, 45, 9), 3)
  })

  test('a candidate already within budget is left untouched', () => {
    // density 3/day, candidate 5d (~15pg) ≤ 40pg cap → stays 5
    assert.equal(capSpanByBudget(5, 15, 45, 80), 5)
  })

  test('no density signal yet (first / empty prior window) → candidate unchanged', () => {
    assert.equal(capSpanByBudget(30, 0, 0, 80), 30)
  })

  test('floors at 1 day even when the pool is nearly dry', () => {
    // density 3/day, budget 1 → cap 1pg → floor(1/3)=0 → MIN
    assert.equal(capSpanByBudget(20, 15, 45, 1), BACKFILL_MIN_SPAN_DAYS)
  })
})

describe('clampSpan', () => {
  test('clamps to [MIN, MAX]', () => {
    assert.equal(clampSpan(0), BACKFILL_MIN_SPAN_DAYS)
    assert.equal(clampSpan(1000), BACKFILL_MAX_SPAN_DAYS)
    assert.equal(clampSpan(20), 20)
  })
})
