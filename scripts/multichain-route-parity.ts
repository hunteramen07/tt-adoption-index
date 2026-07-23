/**
 * npm run test:multichain-route
 *
 * Routing gate for the aggregate-mode multi-chain write branch
 * (src/lib/rwa/multichain-write.ts). Proves that an aggregateFlowsOnly product
 * driven through the multi-chain write tail:
 *   • writes ZERO holder_classifications rows (and resolves ZERO name tags), and
 *   • DOES write aggregate stats (with the market-value weight) + a behavior_history
 *     row,
 * while a per-wallet product through the same dispatch writes the classifications
 * row set as before. It also asserts the routing decision itself (selectWriteMode)
 * against the REAL product config (USDY → aggregate, BUIDL → per-wallet).
 *
 * Runs entirely offline with in-memory recording writers — no network, no Supabase,
 * no writes, fully deterministic. Engine math (holder count / dormancy / mix) is
 * covered by test:engine-parity's 989-holder USDY live check and is NOT re-derived
 * here — this gate is about ROUTING and the write-surface contract only.
 */

import { PRODUCTS } from '@/src/config/products'
import type { Product } from '@/src/config/products'
import type { HolderClassification } from '@/src/lib/classify/types'
import {
  selectWriteMode,
  writeAggregateResult,
  writePerWalletResult,
  type AggregateStats,
  type MultiChainWriters,
  type NameTag,
} from '@/src/lib/rwa/multichain-write'

let failures = 0
const ok = (m: string) => console.log(`  ✓ ${m}`)
const fail = (m: string) => {
  failures++
  console.error(`  ✗ ${m}`)
}
const expect = (label: string, cond: boolean, detail = '') =>
  cond ? ok(label) : fail(`${label}${detail ? ` — ${detail}` : ''}`)

// ── In-memory recording writers ─────────────────────────────────────────────
// The full write surface, counting each call and capturing the last payload, so
// the tests can assert exactly which of the four writes each tail performs.
interface Recorder {
  writers: MultiChainWriters
  calls: {
    resolveNameTags: number
    upsertClassifications: number
    upsertAggregateStats: number
    insertBehaviorHistory: number
  }
  lastAggregate: { network: string; marketValueUsd: number | null; asOfBlock: number; holderCount: number } | null
  lastBehavior: { network: string; holderCount: number } | null
  lastClassifications: { productSlug: string; network: string; count: number } | null
}

function makeRecorder(): Recorder {
  const rec: Recorder = {
    calls: { resolveNameTags: 0, upsertClassifications: 0, upsertAggregateStats: 0, insertBehaviorHistory: 0 },
    lastAggregate: null,
    lastBehavior: null,
    lastClassifications: null,
    writers: undefined as unknown as MultiChainWriters,
  }
  rec.writers = {
    async resolveNameTags(addresses: string[]): Promise<Map<string, NameTag>> {
      rec.calls.resolveNameTags++
      // No tags — exercises the non-custodian path without any network.
      return new Map(addresses.map((a) => [a.toLowerCase(), { nameTag: null, isCustodian: false }]))
    },
    async upsertClassifications(productSlug, classifications, _asOfBlock, network) {
      rec.calls.upsertClassifications++
      rec.lastClassifications = { productSlug, network, count: classifications.size }
    },
    async upsertAggregateStats(stats, network, marketValueUsd) {
      rec.calls.upsertAggregateStats++
      rec.lastAggregate = { network, marketValueUsd, asOfBlock: stats.asOfBlock, holderCount: stats.holderCount }
    },
    async insertBehaviorHistory(stats, network) {
      rec.calls.insertBehaviorHistory++
      rec.lastBehavior = { network, holderCount: stats.holderCount }
    },
  }
  return rec
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function fixtureAggStats(holderCount: number): AggregateStats {
  return {
    holderCount,
    mix: { accumulating: 1, distributing: 1, dormant: 1, active: 1, total: 4 },
    dormancySharePct: 7.9,
    netNewWallets90d: 0,
    exitedWallets90d: 0,
    netAccumulationRatio: 0.5,
  }
}

function fixtureClassifications(): Map<string, HolderClassification> {
  const m = new Map<string, HolderClassification>()
  for (const addr of ['0xaaa', '0xbbb', '0xccc']) {
    m.set(addr, {
      address: addr,
      behavior: 'Active',
      balanceRaw: '1',
      inflowRaw: '1',
      outflowRaw: '0',
      isLabeledCustodian: false,
      nameTag: null,
    })
  }
  return m
}

/** Mirror of the classify.ts multi-chain dispatch: mode chosen by selectWriteMode,
 *  then the matching write tail. Kept in lockstep with classifyRwaMultiChain. */
async function dispatchLikeClassify(
  writers: MultiChainWriters,
  product: Product,
  network: string,
  agg: AggregateStats,
  classifications: Map<string, HolderClassification>,
  marketValueUsd: number | null
): Promise<void> {
  if (selectWriteMode(product) === 'aggregate') {
    await writeAggregateResult(writers, product, agg, network, marketValueUsd)
  } else {
    await writePerWalletResult(writers, product, classifications, agg, network, 0, marketValueUsd)
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

function testRoutingDecisionAgainstRealConfig() {
  console.log('\nselectWriteMode — real product config')
  const usdy = PRODUCTS.find((p) => p.slug === 'usdy')!
  const buidl = PRODUCTS.find((p) => p.slug === 'buidl')!
  expect('USDY (aggregateFlowsOnly) → aggregate', selectWriteMode(usdy) === 'aggregate', selectWriteMode(usdy))
  expect('BUIDL (per-wallet) → per-wallet', selectWriteMode(buidl) === 'per-wallet', selectWriteMode(buidl))
}

async function testAggregateProductThroughPath() {
  console.log('\naggregateFlowsOnly product through the multi-chain path')
  const usdy = PRODUCTS.find((p) => p.slug === 'usdy')!
  const rec = makeRecorder()
  const mv = 123_456.78

  await dispatchLikeClassify(rec.writers, usdy, 'solana', fixtureAggStats(1070), fixtureClassifications(), mv)

  // The headline claim: ZERO per-wallet rows, ZERO name-tag resolution.
  expect('writes zero holder_classifications rows', rec.calls.upsertClassifications === 0, `got ${rec.calls.upsertClassifications}`)
  expect('resolves zero name tags', rec.calls.resolveNameTags === 0, `got ${rec.calls.resolveNameTags}`)
  // And DOES write aggregate stats (with the market-value weight) + behavior history.
  expect('writes aggregate stats exactly once', rec.calls.upsertAggregateStats === 1, `got ${rec.calls.upsertAggregateStats}`)
  expect('writes behavior_history exactly once', rec.calls.insertBehaviorHistory === 1, `got ${rec.calls.insertBehaviorHistory}`)
  expect('aggregate stats carry the market_value_usd weight', rec.lastAggregate?.marketValueUsd === mv, String(rec.lastAggregate?.marketValueUsd))
  expect('aggregate stats use as_of_block 0 (rwa has no block)', rec.lastAggregate?.asOfBlock === 0, String(rec.lastAggregate?.asOfBlock))
  expect('behavior_history holder_count carried from aggStats', rec.lastBehavior?.holderCount === 1070, String(rec.lastBehavior?.holderCount))
}

async function testPerWalletProductThroughPath() {
  console.log('\nper-wallet product through the multi-chain path (contrast)')
  const buidl = PRODUCTS.find((p) => p.slug === 'buidl')!
  const rec = makeRecorder()

  // network 'arbitrum' (non-EVM-nametag branch is ethereum-only) — off-ethereum
  // still writes classifications, just skips name-tag resolution.
  await dispatchLikeClassify(rec.writers, buidl, 'arbitrum', fixtureAggStats(50), fixtureClassifications(), 999)

  expect('writes holder_classifications exactly once', rec.calls.upsertClassifications === 1, `got ${rec.calls.upsertClassifications}`)
  expect('classifications row set has the 3 fixture holders', rec.lastClassifications?.count === 3, String(rec.lastClassifications?.count))
  expect('writes aggregate stats exactly once', rec.calls.upsertAggregateStats === 1, `got ${rec.calls.upsertAggregateStats}`)
  expect('writes behavior_history exactly once', rec.calls.insertBehaviorHistory === 1, `got ${rec.calls.insertBehaviorHistory}`)
  expect('skips name tags off Ethereum', rec.calls.resolveNameTags === 0, `got ${rec.calls.resolveNameTags}`)
}

async function testPerWalletEthereumResolvesNameTags() {
  console.log('\nper-wallet on Ethereum resolves name tags (branch coverage)')
  const buidl = PRODUCTS.find((p) => p.slug === 'buidl')!
  const rec = makeRecorder()

  await dispatchLikeClassify(rec.writers, buidl, 'ethereum', fixtureAggStats(50), fixtureClassifications(), 999)

  expect('resolves name tags on Ethereum', rec.calls.resolveNameTags === 1, `got ${rec.calls.resolveNameTags}`)
  expect('still writes holder_classifications', rec.calls.upsertClassifications === 1, `got ${rec.calls.upsertClassifications}`)
}

async function main() {
  console.log('=== multi-chain routing parity ===')
  testRoutingDecisionAgainstRealConfig()
  await testAggregateProductThroughPath()
  await testPerWalletProductThroughPath()
  await testPerWalletEthereumResolvesNameTags()

  console.log('\n=== result ===')
  if (failures > 0) {
    console.error(`PARITY FAILED: ${failures} assertion(s)`)
    process.exit(1)
  }
  console.log('PARITY OK — aggregate path writes aggregate+behavior only (zero per-wallet rows); routing matches config.')
}

main().catch((err) => {
  console.error('\n[multichain-route-parity] fatal error:', err)
  process.exit(1)
})
