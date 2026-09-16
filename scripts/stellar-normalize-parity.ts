/**
 * npm run test:stellar-normalize
 *
 * Offline gate for the rwa.xyz normalizer on the Stellar feed shape, using every
 * mint and burn in USDY-on-Stellar's history plus a 200-record transfer sample
 * (scripts/fixtures/usdy-stellar-mintburn-2026-09-16.json). No network, no DB.
 *
 * Why this exists: Stellar names the ISSUER account as `from` on mints (all 17), and
 * a null `to` on burns (all 6). The issuer is NOT the configured token address — that
 * is `USDY-<issuer>-1` — so it must be DERIVED (issuerOf in src/config/networks.ts).
 * The null-only normalizer persisted the issuer at −467.5M tokens in usdy:stellar; the
 * token-address-only guard THREW on all 17 real mints. Proves:
 *   1. registry — issuerOf() derives the issuer from the Stellar token address form
 *   2. mints 17/17 → from = zero address; burns 6/6 → to = zero address
 *   3. the issuer never survives as a counterparty; transfers untouched, and the
 *      G… / C… (contract) / L… (liquidity pool) address forms pass through verbatim
 *   4. supply — Σ(mints) − Σ(burns) in raw 7-decimal units equals the /v4/assets
 *      Stellar supply to 1e-7 (= 467,502,185.6411690), i.e. the exact figure the
 *      surgical state fix targets
 *   5. issuer-ledger rule fires REGARDLESS of slug (synthetic unlabeled issuer
 *      payment → zero address, with a warning), and the closed guard still throws on
 *      a mint from a third party and on a null plain transfer
 *   6. non-issuer chains are untouched: the same synthetic record on an EVM network id
 *      is NOT coerced (issuerOf → null) — the rule cannot leak into EVM/Solana paths
 */

import * as fs from 'fs'
import * as path from 'path'
import { normalizeTransaction } from '@/src/lib/rwa/transfers'
import type { RwaTransaction } from '@/src/lib/rwa/transfers'
import { issuerOf, isIssuerLedger } from '@/src/config/networks'

const ZERO = '0x0000000000000000000000000000000000000000'
const DECIMALS = 7

let failures = 0
const ok = (m: string) => console.log(`  ✓ ${m}`)
const fail = (m: string) => { failures++; console.error(`  ✗ ${m}`) }
const expect = (label: string, cond: boolean, detail = '') => (cond ? ok(label) : fail(`${label}${detail ? ` — ${detail}` : ''}`))

const fx = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts', 'fixtures', 'usdy-stellar-mintburn-2026-09-16.json'), 'utf-8')) as {
  assets: { total_supply_token: number; decimals: number; address: string; issuer: string }
  counts: { mint: number; burn: number }
  mints: RwaTransaction[]
  burns: RwaTransaction[]
  transfersSample: RwaTransaction[]
}
const ISSUER = fx.assets.issuer
const tokens = (raw: bigint) => Number(raw) / 10 ** DECIMALS

console.log(`\n=== Stellar normalizer gate — ${fx.mints.length} mints, ${fx.burns.length} burns, ${fx.transfersSample.length} transfers; issuer ${ISSUER} ===\n`)

// 1. registry
expect('issuerOf(9, token address) derives the issuer from CODE-ISSUER-N', issuerOf(9, fx.assets.address) === ISSUER)
expect('Stellar (9) and XRPL (46) are issuer ledgers; Ethereum (1) and Solana (2) are not', isIssuerLedger(9) && isIssuerLedger(46) && !isIssuerLedger(1) && !isIssuerLedger(2))
expect('issuerOf on a non-issuer network is null', issuerOf(1, '0x96f6ef951840721adbf46ac996b59e0235cb985c') === null && issuerOf(2, 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6') === null)
expect('fixture holds every mint and burn (counts match the server-side filter)', fx.mints.length === fx.counts.mint && fx.burns.length === fx.counts.burn)
expect('raw feed: all mints from the issuer, all burns to null, mints and burns labeled',
  fx.mints.every((r) => r.from_address === ISSUER && r.transaction_type?.slug === 'token-mint') && fx.burns.every((r) => r.to_address === null && r.transaction_type?.slug === 'token-burn'))

// 2-3. normalize
const mints = fx.mints.map((r) => normalizeTransaction(r, DECIMALS))
const burns = fx.burns.map((r) => normalizeTransaction(r, DECIMALS))
const transfers = fx.transfersSample.map((r) => normalizeTransaction(r, DECIMALS))
expect('mints 17/17 read from the zero address', mints.every((t) => t.from === ZERO))
expect('burns 6/6 read to the zero address', burns.every((t) => t.to === ZERO))
expect('the issuer never survives as a counterparty', [...mints, ...burns, ...transfers].every((t) => t.from !== ISSUER && t.to !== ISSUER))
expect('transfers keep both real addresses verbatim (G… accounts, C… contracts, L… pools)',
  transfers.every((t, i) => t.from === fx.transfersSample[i].from_address && t.to === fx.transfersSample[i].to_address) &&
  transfers.some((t) => /^C[A-Z2-7]{55}$/.test(t.from) || /^C[A-Z2-7]{55}$/.test(t.to)) &&
  transfers.some((t) => /^L[A-Z2-7]{55}$/.test(t.from) || /^L[A-Z2-7]{55}$/.test(t.to)))

// 4. supply identity
const mintSum = mints.reduce((s, t) => s + BigInt(t.value), BigInt(0))
const burnSum = burns.reduce((s, t) => s + BigInt(t.value), BigInt(0))
const net = mintSum - burnSum
expect(`Σmint − Σburn = ${tokens(net).toFixed(7)} tokens == /v4/assets ${fx.assets.total_supply_token.toFixed(7)} within 1e-7`,
  Math.abs(tokens(net) - fx.assets.total_supply_token) < 1e-7, `diff ${(tokens(net) - fx.assets.total_supply_token).toExponential(3)}`)
expect('Σmint − Σburn == 4675021856411690 raw units (the surgical-fix target, 467,502,185.6411690)', net === BigInt('4675021856411690'), `got ${net}`)

// 5. issuer rule regardless of slug; closed guard intact
const mint0 = fx.mints[0]
const unlabeled: RwaTransaction = { ...mint0, transaction_type: { slug: 'token-transfer' } }
const origWarn = console.warn; let warned = 0; console.warn = () => { warned++ }
const u = normalizeTransaction(unlabeled, DECIMALS)
console.warn = origWarn
expect('an UNLABELED payment from the issuer is still coerced to the zero address (issuer-ledger semantics)', u.from === ZERO)
expect('…and it warns, so a feed change is visible', warned === 1)
let threw = false
try { normalizeTransaction({ ...mint0, from_address: 'GTHIRDPARTYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' }, DECIMALS) } catch { threw = true }
expect('a mint from a third party still THROWS', threw)
threw = false
try { normalizeTransaction({ ...fx.transfersSample[0], from_address: null }, DECIMALS) } catch { threw = true }
expect('a null from_address on a plain transfer still THROWS', threw)
threw = false
try { normalizeTransaction({ ...fx.transfersSample[0], to_address: ISSUER }, DECIMALS) } catch { threw = true }
expect('a payment TO the issuer (redemption) coerces to the zero address, no throw', !threw && normalizeTransaction({ ...fx.transfersSample[0], to_address: ISSUER }, DECIMALS).to === ZERO)

// 6. no leak into non-issuer chains
const evmLike: RwaTransaction = { ...unlabeled, network_id: 1, token: { ...mint0.token, network_id: 1, address: '0x96f6ef951840721adbf46ac996b59e0235cb985c' } }
expect('the same unlabeled record on an EVM network id is NOT coerced (rule scoped to issuer ledgers)', normalizeTransaction(evmLike, DECIMALS).from === ISSUER)

console.log('\n=== result ===')
if (failures > 0) { console.error(`PARITY FAILED — ${failures} check(s) failed`); process.exit(1) }
console.log('PARITY OK — Stellar issuer derived from the token address, mints/burns coerce to the zero address regardless of slug, Σmint − Σburn = /v4/assets supply (467,502,185.6411690), guard still fails loud, rule cannot leak to EVM/Solana.')
