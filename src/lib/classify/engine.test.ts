/** npm run test:engine — residue floor through the classify engine cores. */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyHoldersFromState,
  classifyHolders,
  computeAggregateStatsFromState,
  computeAggregateStats,
  WINDOW_SECONDS,
} from './engine.js'
import { ZERO_FLOOR, isHolderBalance, countHolders } from './residue.js'
import {
  DEFAULT_RESIDUE_EXPONENT,
  ETHEREUM_NETWORK_ID,
  residueExponent,
  residueFloorRaw,
} from '../../config/networks.js'
import type { ERC20Transfer } from '../etherscan/types.js'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const XRPL = 46
const B = (n: number | string) => BigInt(n)

const tx = (from: string, to: string, value: string | number, timeStamp: number): ERC20Transfer =>
  ({
    blockNumber: '0', timeStamp: String(timeStamp), hash: '0x', from, to, value: String(value),
    contractAddress: '0xtoken', tokenName: 'T', tokenSymbol: 'T', tokenDecimal: '18',
  }) as unknown as ERC20Transfer

describe('residue exponent registry (networks.ts)', () => {
  test('default is −9; XRPL is −1', () => {
    assert.equal(DEFAULT_RESIDUE_EXPONENT, -9)
    assert.equal(residueExponent(XRPL), -1)
    for (const id of [ETHEREUM_NETWORK_ID, 2, 3, 8, 9, 11, 33, 38]) assert.equal(residueExponent(id), -9)
  })
  test('floor in raw units is 10^(decimals + exponent)', () => {
    assert.equal(residueFloorRaw(ETHEREUM_NETWORK_ID, 18), B('1000000000'))  // 1e-9 tokens on an 18-dp token
    assert.equal(residueFloorRaw(XRPL, 6), B(100_000))                        // 0.1 tokens on 6-dp XRPL
    assert.equal(residueFloorRaw(XRPL, 18), B(10) ** B(17))
    assert.equal(residueFloorRaw(ETHEREUM_NETWORK_ID, 9), B(1))               // exactly one raw unit
  })
  test('below one raw unit the floor is zero — the historical positive-balance rule', () => {
    assert.equal(residueFloorRaw(ETHEREUM_NETWORK_ID, 6), ZERO_FLOOR) // OUSG, BUIDL, USTB, USYC
    assert.equal(residueFloorRaw(2, 6), ZERO_FLOOR)                   // Solana 6-dp
    assert.equal(residueFloorRaw(9, 7), ZERO_FLOOR)                   // Stellar 7-dp
    assert.equal(residueFloorRaw(ETHEREUM_NETWORK_ID, 8), ZERO_FLOOR)
  })
  test('invalid decimals throw rather than silently flooring', () => {
    assert.throws(() => residueFloorRaw(ETHEREUM_NETWORK_ID, -1))
    assert.throws(() => residueFloorRaw(ETHEREUM_NETWORK_ID, 1.5))
    assert.throws(() => residueFloorRaw(ETHEREUM_NETWORK_ID, NaN))
  })
})

describe('countHolders / isHolderBalance', () => {
  test('a holder is strictly above the floor', () => {
    assert.equal(isHolderBalance(B(1), ZERO_FLOOR), true)
    assert.equal(isHolderBalance(B(0), ZERO_FLOOR), false)
    assert.equal(isHolderBalance(B(-5), ZERO_FLOOR), false)
    assert.equal(isHolderBalance(B(1000), B(1000)), false) // at the floor is residue
    assert.equal(isHolderBalance(B(1001), B(1000)), true)
  })
  test('counts bare bigints and {balance} state rows alike', () => {
    const raw = new Map([['a', B(5)], ['b', B(1000)], ['c', B(1001)], ['d', B(0)]])
    const state = new Map([...raw].map(([k, v]) => [k, { balance: v, firstReceipt: null }]))
    assert.equal(countHolders(raw.values(), B(1000)), 1)
    assert.equal(countHolders(state.values(), B(1000)), 1)
    assert.equal(countHolders(raw.values(), ZERO_FLOOR), 3)
    assert.equal(countHolders(state.values()), 3) // default is the zero floor
  })
  test('zero floor is exactly the positive-balance count (ignores zero rows kept for firstReceipt)', () => {
    const state = new Map([['x', { balance: B(0), firstReceipt: 1 }], ['y', { balance: B(1), firstReceipt: 1 }]])
    assert.equal(countHolders(state.values(), ZERO_FLOOR), 1)
  })
})

// A fixture with one real holder, one residue wallet born in the window, one wallet
// that redeemed down to residue inside the window, and one that fully exited.
const NOW = 2_000_000_000
const before = NOW - WINDOW_SECONDS - 1000
const inside = NOW - 1000
const A = '0x' + 'a'.repeat(40) // real holder, receives in window → Accumulating
const R = '0x' + 'r'.repeat(40) // residue: 500 raw minted inside the window
const C = '0x' + 'c'.repeat(40) // held 100_000 pre-window, shed to 5 raw inside
const D = '0x' + 'd'.repeat(40) // held 50_000 pre-window, fully out inside
const FLOOR = B(1000)
const fixture: ERC20Transfer[] = [
  tx(ZERO_ADDRESS, A, 1_000_000, before),
  tx(ZERO_ADDRESS, C, 100_000, before),
  tx(ZERO_ADDRESS, D, 50_000, before),
  tx(ZERO_ADDRESS, R, 500, inside),
  tx(C, A, 99_995, inside),
  tx(D, A, 50_000, inside),
]

describe('classifyHoldersFromState with a residue floor', () => {
  const balances = new Map([[A, B(1_149_995)], [R, B(500)], [C, B(5)]])
  test('residue wallets get no classification row; real holders are unchanged', () => {
    const floored = classifyHoldersFromState(balances, fixture, NOW, false, FLOOR)
    assert.deepEqual([...floored.keys()], [A])
    assert.equal(floored.get(A)!.behavior, 'Accumulating')
    assert.equal(floored.get(A)!.inflowRaw, '149995')
  })
  test('zero floor classifies every positive balance, as before', () => {
    const zero = classifyHoldersFromState(balances, fixture, NOW, false, ZERO_FLOOR)
    assert.deepEqual([...zero.keys()].sort(), [A, C, R].sort())
    assert.equal(zero.get(R)!.behavior, 'Accumulating')
    assert.equal(zero.get(C)!.behavior, 'Distributing')
    assert.deepEqual(classifyHoldersFromState(balances, fixture, NOW), zero) // default == zero floor
  })
})

describe('computeAggregateStats with a residue floor', () => {
  test('zero floor: the historical counts', () => {
    const s = computeAggregateStats(fixture, NOW, ZERO_FLOOR)
    assert.equal(s.holderCount, 3)          // A, R, C
    assert.equal(s.mix.total, 3)
    assert.equal(s.netNewWallets90d, 1)     // R
    assert.equal(s.exitedWallets90d, 1)     // D
    assert.deepEqual(computeAggregateStats(fixture, NOW), s) // default == zero floor
  })
  test('floored: residue is "holds nothing" for every count', () => {
    const s = computeAggregateStats(fixture, NOW, FLOOR)
    assert.equal(s.holderCount, 1)          // A only
    assert.equal(s.mix.total, 1)
    assert.equal(s.mix.accumulating, 1)
    assert.equal(s.netNewWallets90d, 0)     // R is residue, not a new holder
    assert.equal(s.exitedWallets90d, 2)     // D (fully out) and C (shed to residue)
  })
  test('a wallet born AND left as residue inside the window is neither new nor exited', () => {
    const s = computeAggregateStats(fixture, NOW, FLOOR)
    // R: balanceNow 500 ≤ floor, balanceAtStart = 500 − (500 − 0) = 0 ⇒ not an exit
    assert.equal(s.exitedWallets90d, 2)
    const onlyR = computeAggregateStats([tx(ZERO_ADDRESS, R, 500, inside)], NOW, FLOOR)
    assert.deepEqual([onlyR.holderCount, onlyR.netNewWallets90d, onlyR.exitedWallets90d], [0, 0, 0])
  })
  test('FromState core honours the floor on the state map directly', () => {
    const state = new Map([
      [A, { balance: B(1_149_995), firstReceipt: before }],
      [R, { balance: B(500), firstReceipt: inside }],
      [C, { balance: B(5), firstReceipt: before }],
    ])
    const window = fixture.filter((t) => parseInt(t.timeStamp) >= NOW - WINDOW_SECONDS)
    const floored = computeAggregateStatsFromState(state, window, NOW, false, FLOOR)
    assert.deepEqual([floored.holderCount, floored.netNewWallets90d, floored.exitedWallets90d], [1, 0, 2])
    const zero = computeAggregateStatsFromState(state, window, NOW, false, ZERO_FLOOR)
    assert.deepEqual([zero.holderCount, zero.netNewWallets90d, zero.exitedWallets90d], [3, 1, 1])
    assert.deepEqual(computeAggregateStatsFromState(state, window, NOW, false), zero)
  })
  test('the wrapper threads the floor (classifyHolders)', () => {
    assert.equal(classifyHolders(fixture, NOW, FLOOR).size, 1)
    assert.equal(classifyHolders(fixture, NOW).size, 3)
  })
})
