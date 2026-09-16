/**
 * Unit tests for the shared JSON-RPC failure policy: 429 backoff on the SAME endpoint
 * before falling through, non-429 fallthrough unchanged, redaction of keyed URLs.
 * Run with: npm run test:json-rpc
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  jsonRpc,
  backoffFor429,
  isRateLimitRpcError,
  redactEndpoint,
  RPC_429_MAX_RETRIES,
  RPC_429_BACKOFF_MS,
} from './json-rpc.js'

type Scripted = { status: number; body?: unknown; retryAfter?: string }

/** A fetch stub that replays a per-URL script of responses and records every call. */
function scriptedFetch(script: Record<string, Scripted[]>) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const next = script[url]?.shift()
    if (!next) throw new Error(`no scripted response left for ${url}`)
    const headers = new Headers()
    if (next.retryAfter) headers.set('retry-after', next.retryAfter)
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status, headers })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const A = 'https://a.example/'
const B = 'https://b.example/'
const ok = (v: unknown): Scripted => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { value: v } } })
const pick = (r: unknown) => (r as { value?: number[] } | undefined)?.value

describe('jsonRpc — 429 backoff before endpoint fallthrough', () => {
  test('two 429s then success on the SAME endpoint; B never called; ladder honoured', async () => {
    const { fetchImpl, calls } = scriptedFetch({ [A]: [{ status: 429 }, { status: 429 }, ok([1])], [B]: [ok([2])] })
    const sleeps: number[] = []
    const r = await jsonRpc({
      label: '[t]', method: 'm', params: [], pick, endpoints: [A, B],
      fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms) },
    })
    assert.deepEqual(r, [1])
    assert.deepEqual(calls, [A, A, A])
    assert.deepEqual(sleeps, [RPC_429_BACKOFF_MS[0], RPC_429_BACKOFF_MS[1]])
  })

  test('Retry-After (seconds) overrides the ladder, capped at 15 s', async () => {
    const { fetchImpl } = scriptedFetch({ [A]: [{ status: 429, retryAfter: '3' }, { status: 429, retryAfter: '600' }, ok([1])] })
    const sleeps: number[] = []
    await jsonRpc({ label: '[t]', method: 'm', params: [], pick, endpoints: [A], fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms) } })
    assert.deepEqual(sleeps, [3_000, 15_000])
  })

  test('a JSON-RPC body that says "too many requests" (HTTP 200) is paced like a 429', async () => {
    const limited: Scripted = { status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too Many Requests' } } }
    const { fetchImpl, calls } = scriptedFetch({ [A]: [limited, ok([7])] })
    const sleeps: number[] = []
    const r = await jsonRpc({ label: '[t]', method: 'm', params: [], pick, endpoints: [A], fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms) } })
    assert.deepEqual(r, [7])
    assert.deepEqual(calls, [A, A])
    assert.equal(sleeps.length, 1)
  })

  test('after RPC_429_MAX_RETRIES the endpoint is abandoned and the next one is used', async () => {
    const { fetchImpl, calls } = scriptedFetch({
      [A]: Array.from({ length: RPC_429_MAX_RETRIES + 1 }, () => ({ status: 429 })),
      [B]: [ok([9])],
    })
    const r = await jsonRpc({ label: '[t]', method: 'm', params: [], pick, endpoints: [A, B], fetchImpl, sleepImpl: async () => {} })
    assert.deepEqual(r, [9])
    assert.equal(calls.filter((u) => u === A).length, RPC_429_MAX_RETRIES + 1)
    assert.deepEqual(calls.slice(-1), [B])
  })

  test('non-429 failures keep the old policy: 2 attempts per endpoint, then fall through, no sleeps', async () => {
    const { fetchImpl, calls } = scriptedFetch({ [A]: [{ status: 503 }, { status: 503 }], [B]: [ok([3])] })
    const sleeps: number[] = []
    const r = await jsonRpc({ label: '[t]', method: 'm', params: [], pick, endpoints: [A, B], fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms) } })
    assert.deepEqual(r, [3])
    assert.deepEqual(calls, [A, A, B])
    assert.deepEqual(sleeps, [])
  })

  test('every endpoint failing still throws the "failed on all N endpoint(s)" shape the backfill classifies', async () => {
    const { fetchImpl } = scriptedFetch({ [A]: [{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }], [B]: [{ status: 500 }, { status: 500 }] })
    await assert.rejects(
      jsonRpc({ label: '[solana-resolve]', method: 'getMultipleAccounts', params: [], pick, endpoints: [A, B], fetchImpl, sleepImpl: async () => {} }),
      (e: Error) => /^\[solana-resolve\] getMultipleAccounts failed on all 2 endpoint\(s\): HTTP 500 from b\.example/.test(e.message)
    )
  })
})

describe('helpers', () => {
  test('backoffFor429 ladder and Retry-After handling', () => {
    assert.equal(backoffFor429(0, null), 1_000)
    assert.equal(backoffFor429(3, null), 8_000)
    assert.equal(backoffFor429(9, null), 8_000) // clamps to the last rung
    assert.equal(backoffFor429(0, '2'), 2_000)
    assert.equal(backoffFor429(0, 'garbage'), 1_000)
  })

  test('isRateLimitRpcError recognises the provider variants', () => {
    assert.equal(isRateLimitRpcError({ code: -32429, message: 'x' }), true)
    assert.equal(isRateLimitRpcError({ code: -32029, message: 'Too Many Requests, Please apply an API key' }), true)
    assert.equal(isRateLimitRpcError({ code: 35, message: 'chain is not available on free plan' }), false)
    assert.equal(isRateLimitRpcError(null), false)
  })

  test('redactEndpoint never leaks a key carried in the path or query', () => {
    assert.equal(redactEndpoint('https://api.mainnet-beta.solana.com'), 'api.mainnet-beta.solana.com')
    const r1 = redactEndpoint('https://mainnet.helius-rpc.com/?api-key=SECRET123')
    assert.ok(!r1.includes('SECRET123') && r1.startsWith('mainnet.helius-rpc.com'))
    const r2 = redactEndpoint('https://solana-mainnet.g.alchemy.com/v2/SECRET456')
    assert.ok(!r2.includes('SECRET456') && r2.startsWith('solana-mainnet.g.alchemy.com'))
    assert.ok(redactEndpoint('not a url').startsWith('INVALID('))
  })
})
