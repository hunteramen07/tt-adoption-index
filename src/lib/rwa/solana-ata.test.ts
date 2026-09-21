/**
 * npm run test:solana-ata
 *
 * Vectors verified against chain on 2026-09-20 (getTransaction createIdempotent /
 * initializeAccount3 instructions, and getAccountInfo owner fields).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  base58Decode,
  base58Encode,
  isOnCurve,
  deriveAssociatedTokenAddress,
  isAssociatedTokenAccountOf,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@/src/lib/rwa/solana-ata'

const USDY = 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6'
const USYC = 'CCz3SGVziFeLYk2xfEstkiqJfYkjaSWb2GCABYsVcjo2'

test('base58 round-trips a 32-byte key, including leading zero bytes', () => {
  const b = base58Decode(USDY)
  assert.ok(b && b.length === 32)
  assert.equal(base58Encode(b!), USDY)
  const z = new Uint8Array(32)
  assert.equal(base58Encode(z), '1'.repeat(32))
  assert.deepEqual([...base58Decode('1'.repeat(32))!], [...z])
  assert.equal(base58Decode('0OIl'), null)
})

test('on-curve: a signing wallet is on the curve, a PDA is not', () => {
  assert.equal(isOnCurve(base58Decode('2a2J5rZhmr2ELmCZUoCByAxNQ8154jnHGbB7SwRSPpPe')!), true)  // wallet, signer of 62 txs
  assert.equal(isOnCurve(base58Decode('3YcoFhydWH9MAoW6NsoGB8EBU5Bj8B2eHeL1gcpLXMLa')!), false) // vault PDA
  assert.equal(isOnCurve(base58Decode('JCNCMFXo5M5qwUPg2Utu1u6YWp3MbygxqBsBeXXJfrw')!), false) // Drift PDA
})

test('derives the closed ATA the backfill froze on (bump 255)', () => {
  // tx ESufxc… 2025-03-05: createIdempotent(account=6x9QuW…, wallet=2a2J5r…, mint=USDY)
  const d = deriveAssociatedTokenAddress('2a2J5rZhmr2ELmCZUoCByAxNQ8154jnHGbB7SwRSPpPe', USDY)
  assert.deepEqual(d, { address: '6x9QuWkVWHJbuvHTdPJ5cPWviA9EpVeMomUPBjGauBwK', bump: 255 })
})

test('derives a PDA-owned ATA (bump 253) — the delegate-operated account', () => {
  // getAccountInfo(AXzpX8…): mint USDY, owner 3YcoFh… (off-curve)
  const d = deriveAssociatedTokenAddress('3YcoFhydWH9MAoW6NsoGB8EBU5Bj8B2eHeL1gcpLXMLa', USDY)
  assert.deepEqual(d, { address: 'AXzpX8M91bhxgUAYbX2mN836nMb6xZCWk62cCaxM2t2P', bump: 253 })
})

test('the feed-named signers of the delegate case do NOT derive it', () => {
  for (const signer of [
    'HdCVPDXucoPsGXiTuHuJimeBmEy6ZNxEpY9vnfx56AH8',
    '3MPkoiZFudaead4hoDTS4QvoPjCDCYLZPPeR78LiHWve',
    'G2p46U9dVsuoZitoW8pdima6r3bzbxZSB6A2JfCxDmPs',
  ]) {
    assert.equal(isAssociatedTokenAccountOf('AXzpX8M91bhxgUAYbX2mN836nMb6xZCWk62cCaxM2t2P', signer, [USDY]), null)
  }
})

test('an auxiliary (non-associated) token account derives from nobody', () => {
  // B3qgoC7X… is Drift's USDY vault: initializeAccount by the program, owner JCNCMF… (PDA)
  assert.equal(isAssociatedTokenAccountOf('B3qgoC7XLLxDdkWAdgF83wbzbyaHsZAVMYcieaE9x3CV', 'JCNCMFXo5M5qwUPg2Utu1u6YWp3MbygxqBsBeXXJfrw', [USDY, USYC]), null)
})

test('isAssociatedTokenAccountOf reports which mint and program matched', () => {
  const m = isAssociatedTokenAccountOf('6x9QuWkVWHJbuvHTdPJ5cPWviA9EpVeMomUPBjGauBwK', '2a2J5rZhmr2ELmCZUoCByAxNQ8154jnHGbB7SwRSPpPe', [USYC, USDY])
  assert.deepEqual(m, { mint: USDY, tokenProgram: TOKEN_PROGRAM_ID, bump: 255 })
  assert.notEqual(TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID)
})

test('invalid inputs return null rather than throwing', () => {
  assert.equal(deriveAssociatedTokenAddress('CLOSEDddddddddddddddddddddddddddddddddddddd', USDY), null)
  assert.equal(deriveAssociatedTokenAddress('', USDY), null)
  assert.equal(isAssociatedTokenAccountOf('x', 'y', [USDY]), null)
})
