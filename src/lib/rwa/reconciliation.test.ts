/**
 * Unit tests for the supply-reconciliation tripwire evaluation (pure, offline).
 * Run with: npm run test:reconciliation
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateReconciliation,
  decideBackfillCompletion,
  RECONCILE_WARN_PCT,
  RECONCILE_MIN_NOTIONAL_USD,
  type ReconcileInput,
} from './reconciliation.js'
import type { ChainSupply } from './chain-supply.js'

const chain = (supplyTokens: number): ChainSupply => ({
  supplyTokens,
  supplyRaw: BigInt(Math.round(supplyTokens * 1e6)),
  reference: 'solana:getTokenSupply',
})

/** A $1B-notional network (NAV $1) with a matching state, overridable per test. */
const base = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  stateTokens: 1_000_000_000,
  holderCount: 10,
  negativeCount: 0,
  chain: chain(1_000_000_000),
  assetsSupplyTokens: 1_000_000_000,
  navUsd: 1,
  ...over,
})

describe('evaluateReconciliation — outcomes', () => {
  test('defaults: 3% threshold, $1M floor', () => {
    assert.equal(RECONCILE_WARN_PCT, 3)
    assert.equal(RECONCILE_MIN_NOTIONAL_USD, 1_000_000)
  })

  test('pass: state within threshold of chain', () => {
    const r = evaluateReconciliation(base({ stateTokens: 1_020_000_000 })) // +2%
    assert.equal(r.outcome, 'pass')
    assert.ok(Math.abs(r.deviationPct! - 2) < 1e-9)
    assert.ok(Math.abs(r.ratio! - 1.02) < 1e-9)
    assert.equal(r.notionalUsd, 1_000_000_000)
  })

  test('warn: state beyond threshold (either direction)', () => {
    assert.equal(evaluateReconciliation(base({ stateTokens: 1_031_000_000 })).outcome, 'warn') // +3.1%
    assert.equal(evaluateReconciliation(base({ stateTokens: 969_000_000 })).outcome, 'warn') // −3.1%
  })

  test('exactly at the threshold is a pass (strictly greater warns)', () => {
    const r = evaluateReconciliation(base({ stateTokens: 1_030_000_000, thresholdPct: 3 }))
    assert.equal(r.outcome, 'pass')
  })

  test('the two live Solana gaps that the /v4/assets tripwire missed now warn', () => {
    // buidl:solana 2026-09-10: replay 946.2M vs chain 992.5M (−4.66%)
    const buidl = evaluateReconciliation(base({ stateTokens: 946_212_811.19, chain: chain(992_508_734.52), assetsSupplyTokens: 946_212_811.19 }))
    assert.equal(buidl.outcome, 'warn')
    assert.ok(buidl.deviationPct! > 4.6 && buidl.deviationPct! < 4.7, `got ${buidl.deviationPct}`)
    // ustb:solana: replay 198,105.79 vs chain 174,247.82 (+13.69%), NAV ~$11
    const ustb = evaluateReconciliation(base({ stateTokens: 198_105.787922, chain: chain(174_247.820286), assetsSupplyTokens: 198_105.787922, navUsd: 11 }))
    assert.equal(ustb.outcome, 'warn')
    assert.ok(ustb.deviationPct! > 13.6 && ustb.deviationPct! < 13.8, `got ${ustb.deviationPct}`)
  })

  test('skipped_no_reference: null chain and no error — nothing computed', () => {
    const r = evaluateReconciliation(base({ chain: null }))
    assert.equal(r.outcome, 'skipped_no_reference')
    assert.equal(r.deviationPct, null)
    assert.equal(r.assetsDeltaPct, null)
    assert.equal(r.notionalUsd, null)
  })

  test('skipped_reference_failed: a read error wins over an absent reference', () => {
    const r = evaluateReconciliation(base({ chain: null, chainError: 'timeout' }))
    assert.equal(r.outcome, 'skipped_reference_failed')
    assert.equal(r.deviationPct, null)
  })

  test('skipped_degenerate: chain supply of zero is never a denominator', () => {
    const r = evaluateReconciliation(base({ chain: chain(0), stateTokens: 5 }))
    assert.equal(r.outcome, 'skipped_degenerate')
    assert.equal(r.deviationPct, null)
    assert.equal(r.assetsDeltaPct, null)
  })

  test('skipped_dust: below the notional floor — deviation still reported, no warn', () => {
    // usyc:solana-shaped: ~119 tokens × $1.13 ≈ $134
    const r = evaluateReconciliation(base({ stateTokens: 101, chain: chain(118.97), assetsSupplyTokens: 83.48, navUsd: 1.13 }))
    assert.equal(r.outcome, 'skipped_dust')
    assert.ok(r.deviationPct! > 15, `deviation still computed: ${r.deviationPct}`)
    assert.ok(r.notionalUsd! < RECONCILE_MIN_NOTIONAL_USD)
  })

  test('notional floor uses CHAIN supply × NAV, not state', () => {
    // state is huge but chain says it is dust — the floor follows the reference
    const r = evaluateReconciliation(base({ stateTokens: 50_000_000, chain: chain(10), navUsd: 1 }))
    assert.equal(r.outcome, 'skipped_dust')
  })
})

describe('evaluateReconciliation — assets-vs-chain delta (informational, zero threshold)', () => {
  test('signed: assets above chain is positive, below is negative', () => {
    const above = evaluateReconciliation(base({ assetsSupplyTokens: 1_050_000_000 }))
    const below = evaluateReconciliation(base({ assetsSupplyTokens: 950_000_000 }))
    assert.ok(Math.abs(above.assetsDeltaPct! - 5) < 1e-9)
    assert.ok(Math.abs(below.assetsDeltaPct! + 5) < 1e-9)
  })

  test('never changes the outcome — a 50% rwa gap with a matching state still passes', () => {
    const r = evaluateReconciliation(base({ assetsSupplyTokens: 1_500_000_000 }))
    assert.equal(r.outcome, 'pass')
    assert.ok(Math.abs(r.assetsDeltaPct! - 50) < 1e-9)
  })

  test('null when /v4/assets is unavailable; still computed on a dust skip', () => {
    assert.equal(evaluateReconciliation(base({ assetsSupplyTokens: null })).assetsDeltaPct, null)
    const dust = evaluateReconciliation(base({ stateTokens: 10, chain: chain(10), assetsSupplyTokens: 11, navUsd: 1 }))
    assert.equal(dust.outcome, 'skipped_dust')
    assert.ok(Math.abs(dust.assetsDeltaPct! - 10) < 1e-9)
  })
})

describe('decideBackfillCompletion — fallback when Σ balances ≠ /v4/assets', () => {
  test('ustb:ethereum shape: state within 3% of chain while /v4/assets is 5.7% over chain → complete, skew named', () => {
    const r = evaluateReconciliation(base({ stateTokens: 48_856_055, chain: chain(47_700_823), assetsSupplyTokens: 50_432_673 }))
    assert.equal(r.outcome, 'pass')
    const d = decideBackfillCompletion(r)
    assert.equal(d.complete, true)
    assert.match(d.reason, /within 3% of chain/)
    assert.match(d.reason, /skew vs chain \+5\.72/)
  })

  test('state itself > 3% off chain → stay in_progress (the tripwire warn)', () => {
    const r = evaluateReconciliation(base({ stateTokens: 900_000_000, chain: chain(1_000_000_000), assetsSupplyTokens: 1_000_000_000 }))
    assert.equal(r.outcome, 'warn')
    assert.equal(decideBackfillCompletion(r).complete, false)
  })

  test('no chain reference → stay in_progress', () => {
    const r = evaluateReconciliation(base({ chain: null, assetsSupplyTokens: 1_100_000_000 }))
    assert.equal(r.outcome, 'skipped_no_reference')
    const d = decideBackfillCompletion(r)
    assert.equal(d.complete, false)
    assert.match(d.reason, /no usable chain reference/)
  })

  test('reference read failed this run → stay in_progress', () => {
    const r = evaluateReconciliation(base({ chain: null, chainError: 'timeout', assetsSupplyTokens: 1_100_000_000 }))
    assert.equal(decideBackfillCompletion(r).complete, false)
  })

  test('dust notional still completes when within threshold (deviation is computed for dust)', () => {
    const r = evaluateReconciliation(base({ stateTokens: 100, chain: chain(101), assetsSupplyTokens: 200, navUsd: 1 }))
    assert.equal(r.outcome, 'skipped_dust')
    const d = decideBackfillCompletion(r)
    assert.equal(d.complete, true)
    assert.match(d.reason, /dust notional/)
  })

  test('degenerate chain supply (0) → stay in_progress', () => {
    const r = evaluateReconciliation(base({ stateTokens: 5, chain: chain(0), assetsSupplyTokens: 5 }))
    assert.equal(r.outcome, 'skipped_degenerate')
    assert.equal(decideBackfillCompletion(r).complete, false)
  })
})
