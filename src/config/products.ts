export type ProductSlug = 'buidl' | 'ousg' | 'usdy' | 'benji' | 'ustb' | 'usyc'

/**
 * A single on-chain deployment (token) of a fund on one network.
 *
 * Multi-chain REFERENCE DATA only — consumed by the Stage 1+ rwa.xyz multi-chain
 * pipeline, NOT by the current Ethereum-only pipeline (which uses
 * Product.contractAddress). A fund may have multiple tokens on the same network
 * (e.g. USDY's native + "Certificate" forms on Ethereum), so this is a flat list
 * rather than a map keyed by network.
 *
 * Sourced from rwa.xyz /v4/assets; mirrors its `tokens[]` structure.
 */
export interface ProductToken {
  /** rwa.xyz network_id — authoritative. */
  networkId: number
  /**
   * Lowercase network slug matching rwa.xyz `network.slug` and the Supabase
   * `network` column (e.g. 'ethereum', 'solana', 'xrp-ledger').
   */
  networkSlug: string
  /** Contract address / token identifier in the network's native format. */
  address: string
  /**
   * False for opaque chains where per-wallet flows are not observable (e.g.
   * privacy rails like Canton). All true today — no opaque chains tracked yet.
   */
  behaviorallyObservable: boolean
  /**
   * Token decimals on THIS network. rwa.xyz `amount` is decimal-adjusted to the
   * token's own decimals, which can differ per network for the same fund (e.g.
   * OUSG is 18 on Ethereum/Polygon but 6 on Solana/XRPL). Omit to fall back to
   * the fund-level Product.decimals. fetchTransfersRWA asserts this matches the
   * rwa.xyz token.decimals at fetch time, so a wrong/stale value fails loudly
   * instead of mis-scaling raw units by a power of ten.
   */
  decimals?: number
}

export interface Product {
  slug: ProductSlug
  name: string
  symbol: string
  issuer: string
  /**
   * ERC-20 contract address. All current products are Ethereum mainnet.
   * VERIFY EVERY ADDRESS before deploying — see links below.
   */
  contractAddress: string
  /**
   * Token decimals. Verify against the contract's decimals() return value.
   */
  decimals: number
  /**
   * NAV per token in USD, used to convert raw supply to AUM.
   * REQUIRED for every active fund — do NOT omit, even for stable-$1 funds.
   * Stable-$1 money-market products (BUIDL) must declare navUsd: 1.00 explicitly;
   * accruing-NAV products carry their current price:
   *   OUSG  — bond fund, token started at $100 (Jan 2023), accrues T-bill yield
   *   USDY  — yield note, started at $1, price accrues
   *   USTB  — short-duration fund, started at $1, price accrues
   *   USYC  — yield coin, started at $1, price accrues
   * A missing navUsd on an active fund throws at import time (see getNavUsd and
   * the validation pass at the bottom of this file) — read via getNavUsd(product),
   * never `product.navUsd ?? 1`, so a missing NAV fails loudly instead of
   * silently defaulting to $1.
   *
   * Optional only on the type so inactive placeholders (e.g. BENJI) can omit it.
   *
   * ⚠ HARDCODED — sourced from Etherscan on the date recorded in navAsOf.
   * Update navUsd and navAsOf together when refreshing. Until a live price
   * source is wired (v1.1), refresh monthly.
   */
  navUsd?: number
  /**
   * ISO date (YYYY-MM-DD) when navUsd was last verified.
   * Displayed in debug output and later the UI so staleness is visible.
   * Omit for stable-$1 products whose navUsd does not drift.
   */
  navAsOf?: string
  /**
   * When true, use aggregate transfer flow stats only instead of
   * per-wallet behavioral classification (see METHODOLOGY.md).
   */
  aggregateFlowsOnly?: boolean
  /**
   * When false, this product is excluded from all data fetches.
   * Use ACTIVE_PRODUCTS (instead of PRODUCTS) to iterate only enabled ones.
   * Defaults to true when omitted.
   */
  active?: boolean
  /**
   * rwa.xyz asset_id for this fund. Reference data for the multi-chain rewrite
   * (Stage 1+); not used by the current pipeline.
   */
  rwaAssetId?: number
  /**
   * All tracked on-chain deployments of this fund across networks. Reference
   * data for the Stage 1+ multi-chain pipeline; the current Ethereum-only
   * pipeline ignores this and continues to use contractAddress. Multiple
   * entries per network are permitted (see USDY: native + Certificate).
   */
  tokens?: ProductToken[]
  /**
   * Tokenization platform / technology provider, when distinct from the fund
   * manager (the `issuer` field). E.g. USTB is managed by Invesco but tokenized
   * on Superstate's platform.
   */
  tokenizationPlatform?: string
}

// IMPORTANT: All contract addresses are sourced from training data and MUST
// be manually verified before production use. Check each address at the
// Etherscan link below and confirm it matches the issuer's official docs.
//
// Verification links:
//   BUIDL  https://etherscan.io/token/0x7712c34205737192402172409a8F7ccef8aA2AEC
//   OUSG   https://etherscan.io/token/0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92
//   USDY   https://etherscan.io/token/0x96F6eF951840721AdBF46Ac996b59E0235CB985C
//   BENJI  inactive — see note on the entry below
//   USTB   https://etherscan.io/token/0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e
//   USYC   https://etherscan.io/token/0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b

export const PRODUCTS: Product[] = [
  {
    // BlackRock USD Institutional Digital Liquidity Fund.
    // True stable-$1 money-market fund — NAV is held at $1.00 by design.
    // Declared explicitly (not omitted) so every fund carries an explicit NAV;
    // see getNavUsd + the import-time validation at the bottom of this file.
    slug: 'buidl',
    name: 'BlackRock USD Institutional Digital Liquidity Fund',
    symbol: 'BUIDL',
    issuer: 'BlackRock',
    contractAddress: '0x7712c34205737192402172409a8F7ccef8aA2AEC',
    decimals: 6,
    navUsd: 1.00,
    rwaAssetId: 2331,
    // Distributed class only. BUIDL-I (0x6a9da2...c89041, ~6 holders) is the
    // excluded restricted institutional class — deliberately NOT listed here.
    tokens: [
      { networkId: 1, networkSlug: 'ethereum', address: '0x7712c34205737192402172409a8f7ccef8aa2aec', behaviorallyObservable: true },
      { networkId: 2, networkSlug: 'solana', address: 'GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr', behaviorallyObservable: true },
      { networkId: 3, networkSlug: 'polygon', address: '0x2893ef551b6dd69f661ac00f11d93e5dc5dc0e99', behaviorallyObservable: true },
      { networkId: 4, networkSlug: 'optimism', address: '0xa1cdab15bba75a80df4089cafba013e376957cf5', behaviorallyObservable: true },
      { networkId: 5, networkSlug: 'avalanche-c-chain', address: '0x53fc82f14f009009b440a706e31c9021e1196a2f', behaviorallyObservable: true },
      { networkId: 8, networkSlug: 'bnb-chain', address: '0x2d5bdc96d9c8aabbdb38c9a27398513e7e5ef84f', behaviorallyObservable: true },
      { networkId: 11, networkSlug: 'arbitrum', address: '0xa6525ae43edcd03dc08e775774dcabd3bb925872', behaviorallyObservable: true },
      { networkId: 38, networkSlug: 'aptos', address: '0x50038be55be5b964cfa32cf128b5cf05f123959f286b4cc02b86cafd48945f89', behaviorallyObservable: true },
    ],
  },
  {
    // Ondo US Government Bond — institutional, KYC-gated.
    // Token launched at $100 NAV (Jan 2023) and accrues T-bill yield.
    // The navUsd below was read from Etherscan on 2026-06-11 — update monthly.
    // NOTE: this address tracks Ethereum mainnet only (~39% of total OUSG AUM).
    // OUSG is also on XRP Ledger, Solana, and Polygon; multi-chain coverage TBD.
    slug: 'ousg',
    name: 'Ondo US Government Bond',
    symbol: 'OUSG',
    issuer: 'Ondo Finance',
    contractAddress: '0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92',
    decimals: 18,
    navUsd: 115.53,
    navAsOf: '2026-06-11',
    rwaAssetId: 57,
    tokens: [
      { networkId: 1, networkSlug: 'ethereum', address: '0x1b19c19393e2d034d8ff31ff34c81252fcbbee92', behaviorallyObservable: true, decimals: 18 },
      { networkId: 3, networkSlug: 'polygon', address: '0xba11c5effa33c4d6f8f593cfa394241cfe925811', behaviorallyObservable: true, decimals: 18 },
      { networkId: 2, networkSlug: 'solana', address: 'i7u4r16TcsJTgq1kAG8opmVZyVnAKBwLKu6ZPMwzxNc', behaviorallyObservable: true, decimals: 6 },
      { networkId: 46, networkSlug: 'xrp-ledger', address: 'rHuiXXjHLpMP8ZE9sSQU5aADQVWDwv6h5p', behaviorallyObservable: true, decimals: 6 },
    ],
  },
  {
    // Ondo US Dollar Yield — higher holder count than other products.
    // Per METHODOLOGY.md: aggregate flow stats only, no per-wallet classification.
    // Token price accrues from $1; navUsd read from Etherscan on 2026-06-11.
    // NOTE: Ethereum mainnet is ~45% of total USDY AUM (11 chains total).
    slug: 'usdy',
    name: 'Ondo US Dollar Yield',
    symbol: 'USDY',
    issuer: 'Ondo Finance',
    contractAddress: '0x96F6eF951840721AdBF46Ac996b59E0235CB985C',
    decimals: 18,
    navUsd: 1.13,
    navAsOf: '2026-06-11',
    aggregateFlowsOnly: true,
    rwaAssetId: 60,
    // USDY has TWO Ethereum tokens — native + "Certificate" (purchased-but-not-
    // -fully-unlocked USDY). Same fund/economic exposure; both kept (not collapsed).
    tokens: [
      { networkId: 1, networkSlug: 'ethereum', address: '0x96f6ef951840721adbf46ac996b59e0235cb985c', behaviorallyObservable: true },
      { networkId: 1, networkSlug: 'ethereum', address: '0xe86845788d6e3e5c2393ade1a051ae617d974c09', behaviorallyObservable: true },
      { networkId: 2, networkSlug: 'solana', address: 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', behaviorallyObservable: true },
      { networkId: 9, networkSlug: 'stellar', address: 'USDY-GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6-1', behaviorallyObservable: true },
      { networkId: 11, networkSlug: 'arbitrum', address: '0x35e050d3c0ec2d29d269a8ecea763a183bdf9a9d', behaviorallyObservable: true },
      { networkId: 14, networkSlug: 'noble', address: 'ausdy', behaviorallyObservable: true },
      { networkId: 33, networkSlug: 'mantle', address: '0x5be26527e817998a7206475496fde1e68957c5a6', behaviorallyObservable: true },
      { networkId: 37, networkSlug: 'sui', address: '0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY', behaviorallyObservable: true },
      { networkId: 38, networkSlug: 'aptos', address: '0xf0876baf6f8c37723f0e9d9c1bbad1ccb49324c228bcc906e2f1f5a9e139eda1', behaviorallyObservable: true },
      { networkId: 42, networkSlug: 'mantra', address: 'ibc/6749D16BC09F419C090C330FC751FFF1C96143DB7A4D2FCAEC2F348A3E17618A', behaviorallyObservable: true },
      { networkId: 48, networkSlug: 'plume', address: '0xd2b65e851be3d80d3c2ce795eb2e78f16cb088b2', behaviorallyObservable: true },
      { networkId: 70, networkSlug: 'sei', address: '0x54cd901491aef397084453f4372b93c33260e2a6', behaviorallyObservable: true },
    ],
  },
  {
    // Franklin OnChain US Government Money Fund.
    // BENJI lives primarily on Stellar and Polygon — not Ethereum mainnet.
    // The address previously here (0x59D9356E565Ab3A36dD77763Fc0d87fEaf85508C) is
    // Mountain Protocol USD (USDM), not BENJI. The Polygon contract needs
    // verification and the Etherscan client currently hardcodes chainid=1, so
    // multi-chain support is not yet wired up. Mark inactive until resolved.
    slug: 'benji',
    name: 'Franklin OnChain US Government Money Fund',
    symbol: 'BENJI',
    issuer: 'Franklin Templeton',
    contractAddress: '0x0000000000000000000000000000000000000000', // placeholder — verified address needed
    decimals: 6,
    active: false,
  },
  {
    // Invesco Short Duration US Government Securities Fund.
    // Managed by Invesco; tokenized on Superstate's platform (manager and
    // tokenization provider are now distinct — see tokenizationPlatform).
    // Accumulating fund — token price accrues from $1; NAV ~$11.08 verified
    // 2026-06-16 (rwa.xyz $11.06, CoinGecko $11.10, AUM÷supply $11.06).
    slug: 'ustb',
    name: 'Invesco Short Duration US Government Securities Fund',
    symbol: 'USTB',
    issuer: 'Invesco',
    tokenizationPlatform: 'Superstate',
    contractAddress: '0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e',
    decimals: 6,
    navUsd: 11.08,
    navAsOf: '2026-06-16',
    rwaAssetId: 1385,
    tokens: [
      { networkId: 1, networkSlug: 'ethereum', address: '0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e', behaviorallyObservable: true },
      { networkId: 48, networkSlug: 'plume', address: '0xe4fa682f94610ccd170680cc3b045d77d9e528a8', behaviorallyObservable: true },
      { networkId: 2, networkSlug: 'solana', address: 'CCz3SGVziFeLYk2xfEstkiqJfYkjaSWb2GCABYsVcjo2', behaviorallyObservable: true },
    ],
  },
  {
    // Hashnote US Yield Coin.
    // Primary issuer is now Circle (Circle acquired Hashnote, which originated
    // it); Hashnote recorded as the originating platform — see tokenizationPlatform.
    // Token price accrues from $1; navUsd read from Etherscan on 2026-06-11.
    // NOTE: Ethereum mainnet is ~2.9% of total USYC AUM (Solana + BNB hold the rest).
    slug: 'usyc',
    name: 'Hashnote US Yield Coin',
    symbol: 'USYC',
    issuer: 'Circle',
    tokenizationPlatform: 'Hashnote',
    contractAddress: '0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b',
    decimals: 6,
    navUsd: 1.13,
    navAsOf: '2026-06-11',
    rwaAssetId: 51,
    tokens: [
      { networkId: 1, networkSlug: 'ethereum', address: '0x136471a34f6ef19fe571effc1ca711fdb8e49f2b', behaviorallyObservable: true },
      { networkId: 8, networkSlug: 'bnb-chain', address: '0x8d0fa28f221eb5735bc71d3a0da67ee5bc821311', behaviorallyObservable: true },
      { networkId: 2, networkSlug: 'solana', address: '7LWanZteUKtvFjv4MHYgKXXdAuCQYFPJysL9pxxdRQGn', behaviorallyObservable: true },
    ],
  },
]

export const PRODUCTS_BY_SLUG = Object.fromEntries(
  PRODUCTS.map((p) => [p.slug, p])
) as Record<ProductSlug, Product>

/** Products available for data fetching — excludes entries with active: false. */
export const ACTIVE_PRODUCTS = PRODUCTS.filter((p) => p.active !== false)

/**
 * Returns a product's NAV per token in USD. THROWS if navUsd is missing — every
 * fund must declare an explicit NAV. Use this everywhere instead of
 * `product.navUsd ?? 1`, so a fund missing its NAV fails loudly rather than
 * silently understating AUM by defaulting to $1 (the USTB bug, 2026-06).
 */
export function getNavUsd(product: Product): number {
  if (product.navUsd == null) {
    throw new Error(
      `Missing navUsd for product '${product.slug}' — every fund must declare an explicit NAV (see products.ts).`
    )
  }
  return product.navUsd
}

// Build-time validation: fail loudly at module load if any active fund is
// missing navUsd. This runs once, eagerly, when products.ts is first imported —
// so a missing NAV breaks the next build (during page-data collection) instead
// of 500-ing a live page at request time. Inactive placeholders are exempt.
for (const product of ACTIVE_PRODUCTS) {
  getNavUsd(product)
}
