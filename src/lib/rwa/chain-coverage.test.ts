/** npm run test:chain-coverage */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCoverage, probeNetwork, renderProposal, COVERAGE_MATERIAL_USD } from './chain-coverage.js'
import type { Product } from '@/src/config/products'
import type { RwaAssetToken } from './assets.js'
import type { RwaTransaction } from './transfers.js'

const product = {
  slug: 'buidl',
  name: 'BUIDL',
  symbol: 'BUIDL',
  issuer: 'BlackRock',
  contractAddress: '0x7712c34205737192402172409a8f7ccef8aa2aec',
  decimals: 6,
  navUsd: 1,
  rwaAssetId: 2331,
  tokens: [
    { networkId: 1, networkSlug: 'ethereum', address: '0x7712c34205737192402172409a8f7ccef8aa2aec', behaviorallyObservable: true },
    { networkId: 2, networkSlug: 'solana', address: 'GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr', behaviorallyObservable: true },
    { networkId: 99, networkSlug: 'opaque-chain', address: 'opaque1', behaviorallyObservable: false },
    { networkId: 3, networkSlug: 'polygon', address: '0x2893ef551b6dd69f661ac00f11d93e5dc5dc0e99', behaviorallyObservable: true },
  ],
} as unknown as Product

const tok = (networkId: number, slug: string | null, address: string, supply: number | null, value: number | null, holders = 3): RwaAssetToken => ({
  address,
  decimals: 6,
  network_id: networkId,
  network_name: slug ? slug.toUpperCase() : null,
  network: slug ? { slug } : null,
  total_supply_token: supply == null ? null : { val: supply, val_7d: supply },
  market_value_dollar: value == null ? null : { val: value },
  holding_addresses_count: { val: holders, val_7d: holders },
})

const opts = { multichainSlugs: new Set(['buidl']), backfillAllowed: { buidl: ['polygon'] }, navUsd: 1 }

describe('evaluateCoverage', () => {
  test('classifies every rwa.xyz token into one of the four states', () => {
    const findings = evaluateCoverage(product, [
      tok(1, 'ethereum', '0x7712C34205737192402172409A8F7CCEF8AA2AEC', 100, 100),          // covered (case-insensitive match)
      tok(1, 'ethereum', '0x6a9da2d710bb9b700acde7cb81f10f1ff8c89041', 5e8, 5e8),         // BUIDL-I: known untracked → covered w/ note
      tok(1, 'ethereum', '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 2e6, 2e6),         // unconfigured ADDRESS, material
      tok(99, 'opaque-chain', 'opaque2', 5e6, 5e6),                                       // excluded network (other address)
      tok(99, 'opaque-chain', 'opaque1', 5e6, 5e6),                                       // excluded network (the configured, unobservable address)
      tok(46, 'xrp-ledger', 'rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p', 1.6e6, 1.9e8, 5),      // unconfigured NETWORK, material
      tok(77, null, '0xabc0000000000000000000000000000000000000', null, null, 0),         // new, stats still null
    ], opts)
    const by = (a: string) => findings.find((f) => f.address === a)!
    assert.equal(by('0x7712C34205737192402172409A8F7CCEF8AA2AEC').state, 'covered')
    assert.equal(by('0x6a9da2d710bb9b700acde7cb81f10f1ff8c89041').state, 'covered')
    assert.match(by('0x6a9da2d710bb9b700acde7cb81f10f1ff8c89041').note!, /BUIDL-I/)
    assert.equal(by('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef').state, 'unconfigured_address')
    assert.equal(by('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef').material, true)
    assert.equal(by('opaque2').state, 'excluded_network')
    assert.equal(by('opaque1').state, 'excluded_network')
    assert.match(by('opaque1').note!, /configured as not behaviorally observable/)
    const x = by('rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p')
    assert.equal(x.state, 'unconfigured_network')
    assert.equal(x.material, true)
    assert.equal(x.networkSlug, 'xrp-ledger')
    assert.equal(x.networkSlugDerived, false)
    assert.equal(x.valueSource, 'rwa')
    const n = by('0xabc0000000000000000000000000000000000000')
    assert.equal(n.state, 'unconfigured_network')
    assert.equal(n.material, false)
    assert.equal(n.valueUsd, null)
    assert.equal(n.networkSlug, 'network-77')
    assert.equal(n.networkSlugDerived, true)
  })

  test('configured but not enabled: observable in config, fund off the nightly, network not in BACKFILL_ALLOWED', () => {
    const findings = evaluateCoverage(product, [tok(2, 'solana', 'GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr', 1, 1)], {
      ...opts, multichainSlugs: new Set(), backfillAllowed: { buidl: ['polygon'] },
    })
    assert.equal(findings[0].state, 'configured_not_enabled')
    const enabled = evaluateCoverage(product, [tok(3, 'polygon', '0x2893ef551b6dd69f661ac00f11d93e5dc5dc0e99', 1, 1)], {
      ...opts, multichainSlugs: new Set(),
    })
    assert.equal(enabled[0].state, 'covered')
  })

  test('materiality falls back to supply × NAV when rwa reports no dollar value', () => {
    const [f] = evaluateCoverage(product, [tok(46, 'xrp-ledger', 'rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p', 2e6, 0)], { ...opts, navUsd: 1 })
    assert.equal(f.valueSource, 'nav')
    assert.equal(f.valueUsd, 2e6)
    assert.equal(f.material, true)
    const [g] = evaluateCoverage(product, [tok(46, 'xrp-ledger', 'rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p', 2e6, 0)], { ...opts, navUsd: null })
    assert.equal(g.valueUsd, null)
    assert.equal(g.material, false)
    assert.ok(COVERAGE_MATERIAL_USD === 1_000_000)
  })
})

describe('probe + proposal', () => {
  const rx = (slug: string, from: string | null, to: string | null): RwaTransaction => ({
    id: '46-x-1', from_address: from, to_address: to, amount: 1, timestamp: '2026-09-20T00:00:00.000Z',
    transaction_hash: 'h', transaction_type: { slug }, network_id: 46,
    token: { address: 'rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p', decimals: 6 },
  })

  test('probe is three calls and the proposal carries the answers', async () => {
    const calls: string[] = []
    const probe = await probeNetwork(57, 46, {
      earliestTxDate: async () => { calls.push('earliest'); return '2025-01-10' },
      countWindow: async (_a, _n, gte, lt) => { calls.push(`count ${gte}..${lt}`); return { records: 56, pages: 1 } },
      latestTransactions: async (_a, _n, n) => { calls.push(`latest ${n}`); return [
        rx('token-mint', 'rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p', 'rHolder1'),
        rx('token-burn', 'rHolder1', 'rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p'),
        rx('token-transfer', 'rHolder1', 'rHolder2'),
        rx('token-transfer', 'rHolder1', 'rHolder2'),
      ] },
    }, '2026-09-21')
    assert.deepEqual(calls, ['earliest', 'count 2025-01-10..2026-09-22', 'latest 400'])
    const [f] = evaluateCoverage(product, [tok(46, 'xrp-ledger', 'rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p', 1.6e6, 1.9e8, 5)], opts)
    const text = renderProposal(f, probe)
    assert.match(text, /networkId: 46, networkSlug: 'xrp-ledger', address: 'rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p', behaviorallyObservable: true, decimals: 6/)
    assert.match(text, /56 records since 2025-01-10 \(1 page\(s\)/)
    assert.match(text, /case-SENSITIVE/)
    assert.match(text, /issuer ledger\s+: yes/)
    assert.match(text, /xrpl:gateway_balances \(exists\)/)
    assert.match(text, /2 × token-transfer/)
    assert.match(text, /1 × token-mint: from=token-address/)
    assert.match(text, /1 × token-burn: to=token-address/)
  })

  test('an EVM address on an unknown network says no chain reference exists', async () => {
    const [f] = evaluateCoverage(product, [tok(555, 'newchain', '0xabc0000000000000000000000000000000000000', 5e6, 5e6)], opts)
    const text = renderProposal(f, null)
    assert.match(text, /case-insensitive/)
    assert.match(text, /chain-supply ref\s+: NONE/)
    assert.match(text, /BACKFILL_ALLOWED\s+: add 'newchain' under buidl/)
  })

  test('a network with no rwa.xyz history renders without a probe section', async () => {
    const probe = await probeNetwork(57, 46, {
      earliestTxDate: async () => null,
      countWindow: async () => { throw new Error('must not be called') },
      latestTransactions: async () => { throw new Error('must not be called') },
    }, '2026-09-21')
    assert.equal(probe.records, 0)
    const [f] = evaluateCoverage(product, [tok(46, 'xrp-ledger', 'rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p', null, null, 0)], opts)
    assert.match(renderProposal(f, probe), /no transactions on rwa.xyz yet/)
  })
})
