# RTA Index — Roadmap

Items are listed by theme, not timeline. No dates are committed.

## Infrastructure

**Automated daily classification (GitHub Actions)**
Run the classify pipeline on a nightly cron, commit results to Supabase,
and update behavioral metrics automatically. Eliminates manual `npm run classify`
and ensures /holders and fund behavioral mixes stay current without developer
intervention.

## Coverage

**Multi-chain support + BENJI (v2.0)**
Extend the index to Solana, Polygon, XRP Ledger, Stellar, and other chains
where covered funds operate. Add Franklin Templeton BENJI (currently inactive
due to its Stellar/Polygon-only deployment). Define a formal multi-chain
aggregation methodology — cross-chain holder deduplication is non-trivial.

**Additional funds**
Add new tokenized Treasury and money-market products as they launch on
Ethereum mainnet. Candidates include emerging issuers and new BlackRock /
Ondo product lines.

**Restricted share class policy (v2.0)**
Formalize the coverage rule for products with multiple on-chain share classes.
BUIDL-I is currently excluded because 6 holders measure desk allocation, not
adoption. v2.0 will define explicit thresholds (e.g., exclude classes with
fewer than N holders) and apply them consistently.

## Data quality

**Live NAV prices**
Replace the hardcoded `navUsd` values (refreshed monthly) with a live price
feed (Chainlink, CoinGecko, or issuer oracle). Required for intra-month AUM
accuracy.

**Wrapper-aware classification**
Identify and adjust for DeFi wrapper flows (e.g., Flux Finance fOUSG, Ondo
USDY vaults). Holders who move tokens into wrappers should not be classified
as Distributing unless they have also reduced their total economic exposure.

## Product

**Perps comparison dashboard**
Compare tokenized Treasury yields against on-chain perpetuals funding rates.
Provides context for capital allocation decisions: when T-bill yields exceed
perps funding, tokenized RWAs become more attractive. Planned as a separate
page within the same dashboard.

**Interactive factor explorer**
Expose raw factor values and scoring ranges in the UI so readers can
understand how each component score is derived.
