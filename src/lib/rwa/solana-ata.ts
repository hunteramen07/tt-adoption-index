/**
 * Associated-token-account derivation — the feed-independent check that a claimed
 * ATA→owner mapping is TRUE.
 *
 * WHY. Feed pairing (solana-resolve.ts) reads an owner out of rwa.xyz's underscore
 * feed, on the assumption that the underscore record names the token account's owner
 * wallet. Investigation 2026-09-20 showed that assumption breaking two ways:
 *   • delegate-operated accounts — for a token account owned by a program PDA and
 *     moved by an approved delegate, the underscore feed names the transaction SIGNER,
 *     a different throwaway wallet every time (AXzpX8… → three "owners" in one window,
 *     none of them the real one);
 *   • the former "chase" step — an owner-feed wallet that has SINCE become a token
 *     account (9SJ6qjuG… is now a wrapped-SOL account) was re-resolved through current
 *     chain state to a wallet that never held the position (the one wrong row in
 *     2,790 persisted mappings).
 * No key on feed fields can fix either, because the twin address is simply not the
 * owner. What can: an ATA address is a deterministic function of (owner, token
 * program, mint), so deriving it from the candidate owner and comparing is PROOF —
 * free, offline, and independent of both the feed and current chain state. It covers
 * every associated account (2,749 of the 2,790 persisted rows); the remainder are
 * auxiliary token accounts, which the resolver settles from chain history instead.
 *
 * Pure: base58, sha256 (node:crypto), and an ed25519 on-curve test, no dependencies.
 * Verified against chain on 2026-09-20: 6x9QuW… ← 2a2J5r… (bump 255), AXzpX8… ←
 * 3YcoFh… (bump 253) — see the unit test.
 */

import { createHash } from 'node:crypto'

export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

// ── base58 ──────────────────────────────────────────────────────────────────
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const ALPHABET_INDEX = new Map([...ALPHABET].map((c, i) => [c, i]))

/** Decode a base58 string to bytes, or null if it is not valid base58. */
export function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0) return null
  let n = BigInt(0)
  for (const c of s) {
    const v = ALPHABET_INDEX.get(c)
    if (v === undefined) return null
    n = n * BigInt(58) + BigInt(v)
  }
  const bytes: number[] = []
  while (n > BigInt(0)) {
    bytes.unshift(Number(n & BigInt(255)))
    n >>= BigInt(8)
  }
  let leading = 0
  while (leading < s.length && s[leading] === '1') leading++
  return new Uint8Array([...new Array<number>(leading).fill(0), ...bytes])
}

export function base58Encode(bytes: Uint8Array): string {
  let n = BigInt(0)
  for (const b of bytes) n = (n << BigInt(8)) + BigInt(b)
  let out = ''
  while (n > BigInt(0)) {
    const r = Number(n % BigInt(58))
    out = ALPHABET[r] + out
    n /= BigInt(58)
  }
  let leading = 0
  while (leading < bytes.length && bytes[leading] === 0) leading++
  return '1'.repeat(leading) + out
}

/** A 32-byte public key, or null when the string is not one. */
function pubkeyBytes(s: string): Uint8Array | null {
  const b = base58Decode(s)
  return b && b.length === 32 ? b : null
}

// ── ed25519 on-curve test (RFC 8032 point decompression) ────────────────────
const P = (BigInt(1) << BigInt(255)) - BigInt(19)
const mod = (a: bigint) => ((a % P) + P) % P
function modPow(base: bigint, exp: bigint): bigint {
  let r = BigInt(1)
  let b = mod(base)
  let e = exp
  while (e > BigInt(0)) {
    if (e & BigInt(1)) r = (r * b) % P
    b = (b * b) % P
    e >>= BigInt(1)
  }
  return r
}
const modInv = (a: bigint) => modPow(a, P - BigInt(2))
const D = mod(-BigInt(121665) * modInv(BigInt(121666)))
const SQRT_EXP = (P + BigInt(3)) / BigInt(8)
const SQRT_M1 = modPow(BigInt(2), (P - BigInt(1)) / BigInt(4))

/**
 * True when the 32 bytes decompress to a point on the ed25519 curve. A program-
 * derived address is, by definition, a hash that does NOT — that is what makes it
 * unsignable. Exported for the unit test.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  let y = BigInt(0)
  for (let i = 31; i >= 0; i--) y = (y << BigInt(8)) + BigInt(bytes[i])
  const sign = (y >> BigInt(255)) & BigInt(1)
  y &= (BigInt(1) << BigInt(255)) - BigInt(1)
  if (y >= P) return false
  const y2 = (y * y) % P
  const u = mod(y2 - BigInt(1))
  const v = mod(D * y2 + BigInt(1))
  const x2 = (u * modInv(v)) % P
  let x = modPow(x2, SQRT_EXP)
  if (mod(x * x - x2) !== BigInt(0)) x = (x * SQRT_M1) % P
  if (mod(x * x - x2) !== BigInt(0)) return false
  if (x === BigInt(0) && sign === BigInt(1)) return false
  return true
}

// ── program-derived address ─────────────────────────────────────────────────
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress')

/** findProgramAddress: the first bump (255 downward) whose hash is off-curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): { address: Uint8Array; bump: number } | null {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256')
    for (const s of seeds) h.update(s)
    h.update(new Uint8Array([bump]))
    h.update(programId)
    h.update(PDA_MARKER)
    const digest = new Uint8Array(h.digest())
    if (!isOnCurve(digest)) return { address: digest, bump }
  }
  return null
}

/**
 * The associated token account of `owner` for `mint` under `tokenProgram`, or null
 * when any input is not a valid public key.
 */
export function deriveAssociatedTokenAddress(
  owner: string,
  mint: string,
  tokenProgram: string = TOKEN_PROGRAM_ID
): { address: string; bump: number } | null {
  const o = pubkeyBytes(owner)
  const m = pubkeyBytes(mint)
  const tp = pubkeyBytes(tokenProgram)
  const ap = pubkeyBytes(ASSOCIATED_TOKEN_PROGRAM_ID)
  if (!o || !m || !tp || !ap) return null
  const pda = findProgramAddress([o, tp, m], ap)
  return pda ? { address: base58Encode(pda.address), bump: pda.bump } : null
}

/**
 * Does `ata` derive from `owner` for ANY of `mints` under either token program? Returns
 * the matching (mint, program) as proof, or null. Null is NOT disproof: an auxiliary
 * (non-associated) token account never derives, whoever owns it.
 */
export function isAssociatedTokenAccountOf(
  ata: string,
  owner: string,
  mints: readonly string[]
): { mint: string; tokenProgram: string; bump: number } | null {
  for (const mint of mints) {
    for (const tokenProgram of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const d = deriveAssociatedTokenAddress(owner, mint, tokenProgram)
      if (d && d.address === ata) return { mint, tokenProgram, bump: d.bump }
    }
  }
  return null
}
