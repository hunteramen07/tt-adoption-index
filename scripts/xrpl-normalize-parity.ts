/**
 * npm run test:xrpl-normalize
 *
 * Offline gate for the rwa.xyz normalizer on the XRP Ledger feed shape, using the
 * captured FULL history of OUSG on XRPL (asset 57, network 46 — 56 records as of
 * 2026-09-16, scripts/fixtures/ousg-xrpl-transactions-2026-09-16.json). No network,
 * no DB, deterministic.
 *
 * Why this exists: XRPL is the only chain in the project whose mints and burns name
 * the ISSUER account as the counterparty (from_address on a token-mint, to_address on
 * a token-burn) instead of null (Solana) or the zero address (EVM). The issuer is also
 * the configured token address. Before the slug-guarded coercion in
 * normalizeTransaction, the issuer passed through as an ordinary wallet and a replay
 * left it at −(total supply) — the same defect already visible in the persisted
 * usdy:stellar state. Proves:
 *   1. issuer-never-survives — after normalization no counterparty equals the issuer;
 *      every mint reads from the zero address and every burn to it (9 + 15 records)
 *   2. transfers untouched — the 32 holder-to-holder records keep both real addresses
 *   3. supply — Σ of ALL replayed balances equals rwa.xyz /v4/assets' XRPL supply
 *      (1,639,899.414… tokens) to 1e-6, i.e. Σmint − Σburn; and the positive-balance
 *      holder set (computeBalances) is the 4 real holders, with the issuer absent
 *   4. float32 residue is DOCUMENTED, not hidden — rwa.xyz serves XRPL amounts
 *      float32-rounded, so one redeemed wallet carries a tiny negative and one a tiny
 *      positive; the gate pins their magnitude (< 0.02 tokens) so a change in either
 *      direction is noticed
 *   5. fail-loud guard — a mint whose from_address is a third party still throws
 *      (synthetic), and a null on a plain transfer still throws
 */

import * as fs from 'fs'
import * as path from 'path'
import { normalizeTransaction } from '@/src/lib/rwa/transfers'
import type { RwaTransaction } from '@/src/lib/rwa/transfers'
import { computeBalances } from '@/src/lib/etherscan/balances'

const ZERO = '0x0000000000000000000000000000000000000000'
const DECIMALS = 6

let failures = 0
const ok = (m: string) => console.log(`  ✓ ${m}`)
const fail = (m: string) => { failures++; console.error(`  ✗ ${m}`) }
const expect = (label: string, cond: boolean, detail = '') => (cond ? ok(label) : fail(`${label}${detail ? ` — ${detail}` : ''}`))

const fixturePath = path.join(process.cwd(), 'scripts', 'fixtures', 'ousg-xrpl-transactions-2026-09-16.json')
const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
  resultCount: number
  assets: { total_supply_token: number; holding_addresses_count: number; decimals: number; address: string }
  results: RwaTransaction[]
}
const ISSUER = fx.assets.address
const tokens = (raw: bigint) => Number(raw) / 10 ** DECIMALS

console.log(`\n=== XRPL normalizer gate — ${fx.results.length} captured records (resultCount ${fx.resultCount}), issuer ${ISSUER} ===\n`)
expect('fixture is the full history (results.length === resultCount)', fx.results.length === fx.resultCount)
expect('fixture decimals match config (6)', fx.assets.decimals === DECIMALS && fx.results.every((r) => r.token.decimals === DECIMALS))
expect('raw feed: every mint names the issuer as from_address, every burn as to_address',
  fx.results.filter((r) => r.transaction_type?.slug.includes('mint')).every((r) => r.from_address === ISSUER) &&
  fx.results.filter((r) => r.transaction_type?.slug.includes('burn')).every((r) => r.to_address === ISSUER))

// 1-2. normalize and check counterparties
const normalized = fx.results.map((r) => normalizeTransaction(r, DECIMALS))
const mints = normalized.filter((_, i) => fx.results[i].transaction_type?.slug.includes('mint'))
const burns = normalized.filter((_, i) => fx.results[i].transaction_type?.slug.includes('burn'))
const transfers = normalized.filter((_, i) => fx.results[i].transaction_type?.slug === 'token-transfer')
expect(`mints (${mints.length}) all read from the zero address`, mints.length === 9 && mints.every((t) => t.from === ZERO))
expect(`burns (${burns.length}) all read to the zero address`, burns.length === 15 && burns.every((t) => t.to === ZERO))
expect('the issuer never survives as a counterparty', normalized.every((t) => t.from !== ISSUER && t.to !== ISSUER))
expect(`transfers (${transfers.length}) keep both real r… addresses`, transfers.length === 32 && transfers.every((t) => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(t.from) && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(t.to)))
expect('addresses are passed through verbatim (case preserved)', normalized.every((t, i) => (t.from === ZERO || t.from === fx.results[i].from_address) && (t.to === ZERO || t.to === fx.results[i].to_address)))

// 3. supply: Σ all balances == Σmint − Σburn == /v4/assets supply
const all = new Map<string, bigint>()
for (const t of normalized) {
  const v = BigInt(t.value)
  if (t.from !== ZERO) all.set(t.from, (all.get(t.from) ?? BigInt(0)) - v)
  if (t.to !== ZERO) all.set(t.to, (all.get(t.to) ?? BigInt(0)) + v)
}
const sumAll = [...all.values()].reduce((s, v) => s + v, BigInt(0))
const mintSum = mints.reduce((s, t) => s + BigInt(t.value), BigInt(0))
const burnSum = burns.reduce((s, t) => s + BigInt(t.value), BigInt(0))
expect(`Σ all balances (${tokens(sumAll).toFixed(6)}) == Σmint − Σburn (${tokens(mintSum - burnSum).toFixed(6)})`, sumAll === mintSum - burnSum)
expect(`Σ all balances matches /v4/assets XRPL supply ${fx.assets.total_supply_token.toFixed(6)} within 1e-6 tokens`,
  Math.abs(tokens(sumAll) - fx.assets.total_supply_token) < 1e-6, `diff ${(tokens(sumAll) - fx.assets.total_supply_token).toExponential(3)}`)
expect('Σ all balances == 1,639,899.41 (the approved figure, to 2 dp)', Math.abs(tokens(sumAll) - 1_639_899.41) < 0.005, `got ${tokens(sumAll).toFixed(4)}`)

const positive = computeBalances(normalized)
expect('issuer absent from the positive-balance holder set', !positive.has(ISSUER))
expect(`positive-balance holders = 4 real wallets (got ${positive.size})`, positive.size === 4)

// 4. float32 residue, pinned
const negatives = [...all.entries()].filter(([, v]) => v < BigInt(0))
const dust = [...positive.entries()].filter(([, v]) => tokens(v) < 0.01)
expect(`float32 residue: exactly one tiny negative wallet (got ${negatives.length}: ${negatives.map(([a, v]) => `${a.slice(0, 8)}…=${tokens(v)}`).join(', ')})`,
  negatives.length === 1 && negatives.every(([, v]) => tokens(v) > -0.02))
expect(`float32 residue: exactly one sub-0.01 positive wallet (got ${dust.length}: ${dust.map(([a, v]) => `${a.slice(0, 8)}…=${tokens(v)}`).join(', ')})`, dust.length === 1)
expect('fixture amounts are float32-exact (the documented rwa.xyz XRPL quirk still holds)',
  fx.results.map((r) => r.amount).filter((a) => a !== Math.trunc(a)).every((a) => Math.fround(a) === a))

// 5. guard still fails loud on anything it cannot classify
const base = fx.results.find((r) => r.transaction_type?.slug === 'token-mint')!
const thirdPartyMint: RwaTransaction = { ...base, from_address: 'rThirdPartyNotTheIssuerXXXXXXXXXXXX' }
let threw = false
try { normalizeTransaction(thirdPartyMint, DECIMALS) } catch { threw = true }
expect('a mint whose from_address is a third party still THROWS (no guessing)', threw)
const plain = fx.results.find((r) => r.transaction_type?.slug === 'token-transfer')!
threw = false
try { normalizeTransaction({ ...plain, from_address: null }, DECIMALS) } catch { threw = true }
expect('a null from_address on a plain transfer still THROWS', threw)
const zeroMint: RwaTransaction = { ...base, from_address: ZERO }
expect('an EVM-style zero-address mint still normalizes to the zero address', normalizeTransaction(zeroMint, DECIMALS).from === ZERO)
const nullMint: RwaTransaction = { ...base, from_address: null }
expect('a Solana-style null mint still normalizes to the zero address', normalizeTransaction(nullMint, DECIMALS).from === ZERO)

console.log('\n=== result ===')
if (failures > 0) {
  console.error(`PARITY FAILED — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('PARITY OK — XRPL mints/burns coerce to the zero address, the issuer never survives, Σ balances = /v4/assets supply (1,639,899.41), float32 residue pinned.')
