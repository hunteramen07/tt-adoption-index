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
