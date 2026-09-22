/**
 * Unit tests for the XRPL issued-supply read. Run with: npm run test:xrpl-rpc
 *
 * The reply shapes are the ones rippled actually returned on 2026-09-21 (probe against
 * xrplcluster.com): a success with obligations, and the unknown-account case, which is
 * ALSO status 'success' but with no obligations key.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { xrplIssuedSupply, xrplCurrencyKey, decodeXrplCurrency, decimalStringToRaw, XRPL_NETWORK_ID } from './xrpl-rpc.js'

const ISSUER = 'rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p'
const OUSG_KEY = '4F55534700000000000000000000000000000000'

function scriptedFetch(script: Record<string, unknown[]>) {
  const bodies: unknown[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    bodies.push(JSON.parse(String(init?.body)))
    const next = script[url]?.shift()
    if (next === undefined) throw new Error(`no scripted response left for ${url}`)
    return new Response(JSON.stringify(next), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, bodies }
}

const A = 'https://a.example/'
const B = 'https://b.example/'
const success = (obligations?: Record<string, string>) => ({
  result: { account: ISSUER, ledger_index: 107149571, validated: true, status: 'success', ...(obligations ? { obligations } : {}) },
})

describe('currency keys', () => {
  test('4+ character symbols are hex, right-padded to 40; 3-character codes are plain', () => {
    assert.equal(xrplCurrencyKey('OUSG'), OUSG_KEY)
    assert.equal(xrplCurrencyKey('USD'), 'USD')
    assert.equal(decodeXrplCurrency(OUSG_KEY), 'OUSG')
    assert.equal(decodeXrplCurrency('USD'), 'USD')
  })
})

describe('decimal → raw', () => {
  test('exact at the configured decimals, truncating beyond', () => {
    assert.equal(decimalStringToRaw('1639899.441472341', 6), BigInt('1639899441472'))
    assert.equal(decimalStringToRaw('5', 6), BigInt('5000000'))
    assert.equal(decimalStringToRaw('0.1', 6), BigInt('100000'))
    assert.throws(() => decimalStringToRaw('-1', 6))
    assert.throws(() => decimalStringToRaw('1e5', 6))
  })
})

describe('xrplIssuedSupply', () => {
  test('reads the symbol\'s obligation from a validated ledger and sends the rippled request shape', async () => {
    const { fetchImpl, bodies } = scriptedFetch({ [A]: [success({ [OUSG_KEY]: '1639899.441472341' })] })
    const s = await xrplIssuedSupply(ISSUER, 'OUSG', 6, [A], fetchImpl)
    assert.deepEqual(s, { supplyRaw: BigInt('1639899441472'), currencyKey: OUSG_KEY, ledgerIndex: 107149571 })
    const body = bodies[0] as { method: string; params: unknown[] }
    assert.equal(body.method, 'gateway_balances')
    assert.deepEqual(body.params, [{ account: ISSUER, ledger_index: 'validated', strict: true }])
  })

  test('an unknown account (success with no obligations) is a failed read, never a zero supply', async () => {
    const { fetchImpl } = scriptedFetch({ [A]: [success(), success()], [B]: [success(), success()] })
    await assert.rejects(() => xrplIssuedSupply(ISSUER, 'OUSG', 6, [A, B], fetchImpl), /failed on all 2 endpoint/)
  })

  test('a rippled error (status inside result) fails over to the next endpoint', async () => {
    const { fetchImpl } = scriptedFetch({
      [A]: [{ result: { status: 'error', error: 'tooBusy' } }, { result: { status: 'error', error: 'tooBusy' } }],
      [B]: [success({ [OUSG_KEY]: '10' })],
    })
    const s = await xrplIssuedSupply(ISSUER, 'OUSG', 6, [A, B], fetchImpl)
    assert.equal(s.supplyRaw, BigInt('10000000'))
  })

  test('an issuer without this currency throws, naming what it does carry', async () => {
    const { fetchImpl } = scriptedFetch({ [A]: [success({ USD: '1', [xrplCurrencyKey('USDY')]: '2' })] })
    await assert.rejects(() => xrplIssuedSupply(ISSUER, 'OUSG', 6, [A], fetchImpl), /no OUSG obligation \(currencies: USD, USDY\)/)
  })

  test('network id matches the products config', () => {
    assert.equal(XRPL_NETWORK_ID, 46)
  })
})
