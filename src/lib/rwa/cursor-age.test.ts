/** npm run test:cursor-age */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCursorAge, findOrphanedCursors, CURSOR_STALE_DAYS, CURSOR_STALE_QUIET_DAYS } from './cursor-age.js'

const NOW = Date.parse('2026-09-21T07:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

describe('evaluateCursorAge', () => {
  test('fresh cursor is fine regardless of activity', () => {
    for (const activity of [null, { supplyMoved: true, holdersMoved: true }, { supplyMoved: false, holdersMoved: false }]) {
      const r = evaluateCursorAge({ lastTxTimestamp: daysAgo(1), nowMs: NOW, activity })
      assert.equal(r.stale, false, JSON.stringify(activity))
    }
  })

  test('the usdy:ethereum shape — weeks old while the feed moved — is stale at the activity threshold', () => {
    const r = evaluateCursorAge({ lastTxTimestamp: daysAgo(49), nowMs: NOW, activity: { supplyMoved: true, holdersMoved: false } })
    assert.equal(r.stale, true)
    assert.equal(r.thresholdDays, CURSOR_STALE_DAYS)
    assert.match(r.reason, /supply moved/)
    assert.ok(r.ageDays! > 48 && r.ageDays! < 50)
  })

  test('just past the activity threshold trips only when something moved', () => {
    const age = daysAgo(CURSOR_STALE_DAYS + 0.5)
    assert.equal(evaluateCursorAge({ lastTxTimestamp: age, nowMs: NOW, activity: { supplyMoved: false, holdersMoved: true } }).stale, true)
    assert.equal(evaluateCursorAge({ lastTxTimestamp: age, nowMs: NOW, activity: { supplyMoved: false, holdersMoved: false } }).stale, false)
    assert.equal(evaluateCursorAge({ lastTxTimestamp: age, nowMs: NOW, activity: null }).stale, false)
  })

  test('a quiet network is reported only past the quiet ceiling', () => {
    const quiet = { supplyMoved: false, holdersMoved: false }
    assert.equal(evaluateCursorAge({ lastTxTimestamp: daysAgo(CURSOR_STALE_QUIET_DAYS - 1), nowMs: NOW, activity: quiet }).stale, false)
    const r = evaluateCursorAge({ lastTxTimestamp: daysAgo(CURSOR_STALE_QUIET_DAYS + 1), nowMs: NOW, activity: quiet })
    assert.equal(r.stale, true)
    assert.equal(r.thresholdDays, CURSOR_STALE_QUIET_DAYS)
    assert.match(r.reason, /quiet-network ceiling/)
  })

  test('no cursor is not an age question', () => {
    const r = evaluateCursorAge({ lastTxTimestamp: null, nowMs: NOW, activity: { supplyMoved: true, holdersMoved: true } })
    assert.equal(r.stale, false)
    assert.equal(r.ageDays, null)
  })
})

describe('findOrphanedCursors', () => {
  const configured = new Map<string, Set<string>>([
    ['usdy', new Set(['ethereum', 'solana', 'stellar'])],
    ['buidl', new Set(['ethereum', 'solana'])],
  ])
  const multichain = new Set(['buidl'])

  test('a completed cursor on a fund outside the nightly set is orphaned (the usdy case)', () => {
    const out = findOrphanedCursors(
      [{ product_slug: 'usdy', network: 'ethereum', backfill_complete: true, last_tx_timestamp: daysAgo(49) }],
      { nowMs: NOW, multichainSlugs: multichain, configuredNetworks: configured }
    )
    assert.equal(out.length, 1)
    assert.match(out[0].reason, /not in RWA_MULTICHAIN_SLUGS/)
    assert.ok(out[0].ageDays! > 48)
  })

  test('an in-progress backfill is the backfill\'s business, not an orphan', () => {
    const out = findOrphanedCursors(
      [{ product_slug: 'usdy', network: 'solana', backfill_complete: false, last_tx_timestamp: daysAgo(300) }],
      { nowMs: NOW, multichainSlugs: multichain, configuredNetworks: configured }
    )
    assert.equal(out.length, 0)
  })

  test('a completed cursor on a nightly fund is healthy', () => {
    const out = findOrphanedCursors(
      [{ product_slug: 'buidl', network: 'solana', backfill_complete: true, last_tx_timestamp: daysAgo(1) }],
      { nowMs: NOW, multichainSlugs: multichain, configuredNetworks: configured }
    )
    assert.equal(out.length, 0)
  })

  test('a cursor on a network no longer configured is orphaned even on a nightly fund', () => {
    const out = findOrphanedCursors(
      [{ product_slug: 'buidl', network: 'polygon', backfill_complete: true, last_tx_timestamp: null }],
      { nowMs: NOW, multichainSlugs: multichain, configuredNetworks: configured }
    )
    assert.equal(out.length, 1)
    assert.match(out[0].reason, /not configured/)
    assert.equal(out[0].ageDays, null)
  })
})
