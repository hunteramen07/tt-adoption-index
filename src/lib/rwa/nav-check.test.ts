/** npm run test:nav-check */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateNavStaleness, evaluateNavDrift, NAV_STALE_DAYS, NAV_DRIFT_PCT } from './nav-check.js'
import type { RwaAssetToken } from './assets.js'

const NOW = Date.parse('2026-09-21T07:00:00Z')
const tok = (supply: number | null, value: number | null): RwaAssetToken => ({
  address: 'x', decimals: 6, network_id: 1, network_name: null,
  total_supply_token: supply == null ? null : { val: supply },
  market_value_dollar: value == null ? null : { val: value },
})

describe('evaluateNavStaleness', () => {
  test('every NAV verified 2026-07-22 is stale on 2026-09-21 (61 days > 45)', () => {
    const r = evaluateNavStaleness({ slug: 'ousg', navAsOf: '2026-07-22' }, NOW)
    assert.equal(r.stale, true)
    assert.ok(r.ageDays! > 60 && r.ageDays! < 62)
    assert.match(r.reason, /> 45/)
  })
  test('a fresh verification is fine', () => {
    assert.equal(evaluateNavStaleness({ slug: 'ousg', navAsOf: '2026-09-01' }, NOW).stale, false)
  })
  test('the boundary is exclusive at NAV_STALE_DAYS', () => {
    const exactly = new Date(NOW - NAV_STALE_DAYS * 86_400_000).toISOString().slice(0, 10)
    // navAsOf is a date (midnight UTC); NOW is 07:00, so exactly-45-days is 45.29 days → stale.
    assert.equal(evaluateNavStaleness({ slug: 'buidl', navAsOf: exactly }, NOW).stale, true)
    const inside = new Date(NOW - (NAV_STALE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
    assert.equal(evaluateNavStaleness({ slug: 'buidl', navAsOf: inside }, NOW).stale, false)
  })
  test('no navAsOf is reported stale, not skipped', () => {
    const r = evaluateNavStaleness({ slug: 'buidl' }, NOW)
    assert.equal(r.stale, true)
    assert.equal(r.ageDays, null)
  })
})

describe('evaluateNavDrift', () => {
  test('the 2026-09-21 live figures: OUSG +0.56% is within 2%', () => {
    const r = evaluateNavDrift({ slug: 'ousg', navUsd: 115.96 }, [tok(624_604, 72_832_201), tok(1_134_550.55, 132_294_723.8), tok(1_639_899.41, 191_221_132.1), tok(1.4e-11, 1.7e-9)])
    assert.equal(r.outcome, 'ok')
    assert.ok(Math.abs(r.driftPct! - 0.56) < 0.05, String(r.driftPct))
    assert.equal(r.networksUsed, 4)
  })
  test('a stale config NAV against a moved market trips', () => {
    const r = evaluateNavDrift({ slug: 'ousg', navUsd: 110 }, [tok(1000, 116_600)])
    assert.equal(r.outcome, 'drift')
    assert.ok(r.driftPct! > NAV_DRIFT_PCT)
    assert.match(r.reason, /beyond 2%/)
  })
  test('BUIDL/USTB shape — rwa reports zero dollar value — is skipped, never priced at 0', () => {
    const r = evaluateNavDrift({ slug: 'ustb', navUsd: 11.13 }, [tok(50_913_728, 0), tok(1000, null)])
    assert.equal(r.outcome, 'skipped_no_value')
    assert.equal(r.impliedNav, null)
    assert.equal(r.driftPct, null)
  })
  test('networks without a value are left out of the implied price rather than dragging it to zero', () => {
    const r = evaluateNavDrift({ slug: 'usdy', navUsd: 1.14 }, [tok(1000, 1140), tok(5000, 0), tok(null, null)])
    assert.equal(r.networksUsed, 1)
    assert.ok(Math.abs(r.impliedNav! - 1.14) < 1e-9)
    assert.equal(r.outcome, 'ok')
  })
})
