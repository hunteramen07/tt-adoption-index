export type ProductSlug = 'buidl' | 'ousg' | 'usdy' | 'benji' | 'ustb' | 'usyc'

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
   * Omit (or set to 1) for stable-$1 money-market products (BUIDL, USTB).
   * Must be set for products whose token price accrues away from $1:
   *   OUSG  — bond fund, token started at $100 (Jan 2023), accrues T-bill yield
   *   USDY  — yield note, started at $1, price accrues
   *   USYC  — yield coin, started at $1, price accrues
   *
   * ⚠ HARDCODED — sourced from Etherscan on the date recorded in navAsOf.
   * Update navUsd and navAsOf together when refreshing. Until a live price
   * source is wired (v1.1), refresh monthly.
   */
  navUsd?: number
  /**
   * ISO date (YYYY-MM-DD) when navUsd was last verified.
   * Displayed in debug output and later the UI so staleness is visible.
   * Omit for stable-$1 products where navUsd defaults to 1.
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
    // BlackRock USD Institutional Digital Liquidity Fund
    slug: 'buidl',
    name: 'BlackRock USD Institutional Digital Liquidity Fund',
    symbol: 'BUIDL',
    issuer: 'BlackRock',
    contractAddress: '0x7712c34205737192402172409a8F7ccef8aA2AEC',
    decimals: 6,
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
    // Superstate Short Duration US Government Securities Fund
    slug: 'ustb',
    name: 'Superstate Short Duration US Government Securities Fund',
    symbol: 'USTB',
    issuer: 'Superstate',
    contractAddress: '0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e',
    decimals: 6,
  },
  {
    // Hashnote US Yield Coin (now operated by Circle).
    // Token price accrues from $1; navUsd read from Etherscan on 2026-06-11.
    // NOTE: Ethereum mainnet is ~2.9% of total USYC AUM (Solana + BNB hold the rest).
    slug: 'usyc',
    name: 'Hashnote US Yield Coin',
    symbol: 'USYC',
    issuer: 'Hashnote',
    contractAddress: '0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b',
    decimals: 6,
    navUsd: 1.13,
    navAsOf: '2026-06-11',
  },
]

export const PRODUCTS_BY_SLUG = Object.fromEntries(
  PRODUCTS.map((p) => [p.slug, p])
) as Record<ProductSlug, Product>

/** Products available for data fetching — excludes entries with active: false. */
export const ACTIVE_PRODUCTS = PRODUCTS.filter((p) => p.active !== false)
