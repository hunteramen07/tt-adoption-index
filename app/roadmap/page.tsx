export const metadata = {
  title: 'Roadmap — RTA Index',
}

// ─── Small prose helpers ──────────────────────────────────────────────────────

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mt-10 mb-3 first:mt-0">
      {children}
    </h2>
  )
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-zinc-700 mt-5 mb-1.5">
      {children}
    </h3>
  )
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-zinc-600 leading-relaxed mb-3">{children}</p>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function RoadmapPage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
        {/* Title */}
        <div className="mb-8">
          <h1 className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-1">
            Roadmap
          </h1>
          <p className="text-lg font-semibold text-zinc-900">
            RTA Index &mdash; Planned Work
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            Items are listed by theme, not timeline. No dates are committed.
          </p>
        </div>

        {/* Infrastructure */}
        <H2>Infrastructure</H2>
        <H3>Automated daily classification (GitHub Actions)</H3>
        <P>
          Run the classify pipeline on a nightly cron, commit results to Supabase,
          and update behavioral metrics automatically. Eliminates manual{' '}
          <code className="text-xs bg-zinc-100 px-1 py-0.5 rounded">npm run classify</code>{' '}
          and ensures /holders and fund behavioral mixes stay current without developer
          intervention.
        </P>

        {/* Coverage */}
        <H2>Coverage</H2>
        <H3>Multi-chain support + BENJI (v2.0)</H3>
        <P>
          Extend the index to Solana, Polygon, XRP Ledger, Stellar, and other chains
          where covered funds operate. Add Franklin Templeton BENJI (currently inactive
          due to its Stellar/Polygon-only deployment). Define a formal multi-chain
          aggregation methodology &mdash; cross-chain holder deduplication is non-trivial.
        </P>
        <H3>Additional funds</H3>
        <P>
          Add new tokenized Treasury and money-market products as they launch on
          Ethereum mainnet. Candidates include emerging issuers and new BlackRock /
          Ondo product lines.
        </P>
        <H3>Restricted share class policy (v2.0)</H3>
        <P>
          Formalize the coverage rule for products with multiple on-chain share classes.
          BUIDL-I is currently excluded because 6 holders measure desk allocation, not
          adoption. v2.0 will define explicit thresholds (e.g., exclude classes with
          fewer than N holders) and apply them consistently.
        </P>

        {/* Data quality */}
        <H2>Data Quality</H2>
        <H3>Live NAV prices</H3>
        <P>
          Replace the hardcoded <code className="text-xs bg-zinc-100 px-1 py-0.5 rounded">navUsd</code>{' '}
          values (refreshed monthly) with a live price feed (Chainlink, CoinGecko, or
          issuer oracle). Required for intra-month AUM accuracy.
        </P>
        <H3>Wrapper-aware classification</H3>
        <P>
          Identify and adjust for DeFi wrapper flows (e.g., Flux Finance fOUSG, Ondo
          USDY vaults). Holders who move tokens into wrappers should not be classified
          as Distributing unless they have also reduced their total economic exposure.
        </P>

        {/* Product */}
        <H2>Product</H2>
        <H3>Perps comparison dashboard</H3>
        <P>
          Compare tokenized Treasury yields against on-chain perpetuals funding rates.
          Provides context for capital allocation decisions: when T-bill yields exceed
          perps funding, tokenized RWAs become more attractive. Planned as a separate
          page within the same dashboard.
        </P>
        <H3>Interactive factor explorer</H3>
        <P>
          Expose raw factor values and scoring ranges in the UI so readers can
          understand how each component score is derived.
        </P>
      </main>

      <footer className="border-t border-zinc-100 mt-10 px-4 sm:px-6 py-6">
        <div className="max-w-7xl mx-auto text-xs text-zinc-400">
          RTA Index &middot; Ethereum mainnet only &middot; Not financial advice
        </div>
      </footer>
    </div>
  )
}
