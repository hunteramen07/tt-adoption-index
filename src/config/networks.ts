/**
 * Network-level metadata keyed by rwa.xyz network_id.
 *
 * Address case-sensitivity is a property of a chain's ADDRESS ENCODING, not of
 * whether it is EVM — so it is declared once per network here, rather than as a
 * per-token flag that could drift or be forgotten on a new entry (a forgotten
 * flag would silently corrupt a case-sensitive chain — the exact class of bug
 * this registry exists to prevent).
 *
 *   case-INsensitive (safe to lowercase, unifies mixed-case dupes):
 *     • hex   — EVM chains (ethereum, polygon, optimism, avalanche, bnb,
 *               arbitrum, mantle), Aptos, Sui
 *     • bech32 — Noble (cosmos; lowercase-canonical)
 *   case-SENSITIVE (MUST be preserved verbatim or distinct wallets collide):
 *     • base58 — Solana, XRP Ledger (r…)
 *     • base32/StrKey — Stellar
 *
 * If a balance/identity ever looks wrong on a newly-added chain, check this set
 * first. networkId values match src/config/products.ts token entries.
 */
export const CASE_SENSITIVE_NETWORK_IDS = new Set<number>([
  2, // solana — base58
  9, // stellar — base32 StrKey
  46, // xrp-ledger — base58 (r…)
])

/** True when the network's address encoding is case-sensitive (base58/base32). */
export const isCaseSensitive = (networkId: number): boolean =>
  CASE_SENSITIVE_NETWORK_IDS.has(networkId)

/**
 * Issuer-ledger networks: chains where a token is an IOU of an ISSUER ACCOUNT and the
 * ledger itself defines a payment FROM the issuer as issuance and a payment TO the
 * issuer as redemption (the issuer cannot hold its own IOU). rwa.xyz names that issuer
 * as the mint/burn counterparty instead of null (Solana/Aptos) or the zero address
 * (EVM) — on XRPL on both sides, on Stellar on the mint side (burns arrive with a null
 * `to`). The issuer must therefore be coerced to the zero-address sentinel or it is
 * persisted at −(total supply): usdy:stellar sat at −467.5M tokens for exactly this
 * reason (2026-09-16).
 *
 * Keyed by rwa.xyz network_id; the value derives the issuer account from rwa.xyz's
 * token address form for that chain. Not an issuer ledger ⇒ absent ⇒ issuerOf() null.
 */
const ISSUER_OF_TOKEN_ADDRESS: Record<number, (tokenAddress: string) => string | null> = {
  // Stellar (9): rwa.xyz token address is `CODE-ISSUER-N` (e.g.
  // `USDY-GAJMPX5N…TADAZ6-1`); the issuer is the G… StrKey in the middle.
  9: (addr) => {
    const parts = addr.split('-')
    return parts.length >= 2 && /^G[A-Z2-7]{55}$/.test(parts[1]) ? parts[1] : null
  },
  // XRP Ledger (46): rwa.xyz token address IS the issuer account (r…).
  46: (addr) => (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr) ? addr : null),
}

/** The issuer account behind a token on an issuer-ledger network, or null when the
 *  network has no issuer semantics (EVM, Solana, Aptos, …) or the address form is not
 *  the one rwa.xyz uses for that chain. */
export const issuerOf = (networkId: number, tokenAddress: string): string | null =>
  ISSUER_OF_TOKEN_ADDRESS[networkId]?.(tokenAddress) ?? null

/** True for networks with issuer semantics (see ISSUER_OF_TOKEN_ADDRESS). */
export const isIssuerLedger = (networkId: number): boolean => networkId in ISSUER_OF_TOKEN_ADDRESS

/**
 * Residue floor — the balance at or below which a wallet is NOT counted as a holder.
 *
 * rwa.xyz serves amounts as decimal floats, so replaying them into raw units strands
 * phantom positions: float64 reconstruction on 18-decimal tokens leaves sub-1e-12
 * token balances in wallets that fully redeemed, and XRPL (and Stellar) amounts are
 * float32-rounded, which leaves one redeemed OUSG wallet on XRPL holding < 0.02
 * tokens (scripts/xrpl-normalize-parity.ts pins it). None of these are holders, and
 * counting them inflates holder_count (usdy-aggregate-multichain-design.md §4).
 *
 * The floor is a power of ten in WHOLE TOKENS so one rule applies across chains
 * regardless of decimals: a wallet is a holder iff balance > 10^exponent tokens.
 *   • default −9 — 1e-9 tokens. Below one raw unit on every ≤ 8-decimal token (so
 *     the count there is exactly the positive-balance count, as before) and three
 *     orders of magnitude above the float64 residue on 18-decimal tokens.
 *   • XRPL (46) −1 — 0.1 tokens, above the float32 residue. OUSG is ~$116/token,
 *     so 0.1 tokens is ~$12: still far below any real position.
 *
 * It is a COUNTING rule only. Balance state, Σ-balance supply sums and the
 * reconciliation tripwire are untouched: residue nets to ~0 and the Σ identity must
 * include it. Keyed by rwa.xyz network_id; absent ⇒ the default.
 */
export const DEFAULT_RESIDUE_EXPONENT = -9
const RESIDUE_EXPONENT_BY_NETWORK: Record<number, number> = {
  46: -1, // xrp-ledger — float32-rounded amounts
}

/** The residue exponent for a network: holder iff balance > 10^exponent tokens. */
export const residueExponent = (networkId: number): number =>
  RESIDUE_EXPONENT_BY_NETWORK[networkId] ?? DEFAULT_RESIDUE_EXPONENT

/** Ethereum's rwa.xyz network_id — the Etherscan-fed paths are Ethereum-only. */
export const ETHEREUM_NETWORK_ID = 1

/**
 * The residue floor in RAW units for a token with `decimals` on `networkId`:
 * 10^(decimals + exponent), or 0 when that is below one raw unit (holder iff
 * balance > 0 — the historical rule). A holder's raw balance is strictly ABOVE this
 * value; countHolders (src/lib/classify/residue.ts) applies it.
 */
export const residueFloorRaw = (networkId: number, decimals: number): bigint => {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`residueFloorRaw: invalid decimals ${decimals} for network ${networkId}`)
  }
  const e = decimals + residueExponent(networkId)
  return e < 0 ? BigInt(0) : BigInt(10) ** BigInt(e)
}
