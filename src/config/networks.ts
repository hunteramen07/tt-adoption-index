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
