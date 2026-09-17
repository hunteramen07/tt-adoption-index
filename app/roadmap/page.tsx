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

/** Status marker next to an item heading. Items without one are planned. */
function Status({ kind }: { kind: 'shipped' | 'in-progress' }) {
  const label = kind === 'shipped' ? 'Shipped' : 'In progress'
  const cls =
    kind === 'shipped'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : 'bg-amber-50 text-amber-700 border-amber-200'
  return (
    <span className={`ml-2 align-middle inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border ${cls}`}>
      {label}
    </span>
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
            Items are listed by theme, not timeline. No dates are committed. Items
            without a status marker are planned.
          </p>
        </div>

        {/* Infrastructure */}
        <H2>Infrastructure</H2>
        <H3>
          Automated daily classification (GitHub Actions)
          <Status kind="shipped" />
        </H3>
        <P>
          Live since June 2026. Two GitHub Actions crons run every day: the classify
          pipeline at 07:00 UTC writes holder classifications, behavioral metrics and the
          behavior history to Supabase, and a 06:30 UTC job refreshes the AUM-over-time
          data. /holders and the fund behavioral mixes stay current with no manual{' '}
          <code className="text-xs bg-zinc-100 px-1 py-0.5 rounded">npm run classify</code>{' '}
          in steady state.
        </P>

        {/* Coverage */}
        <H2>Coverage</H2>
        <H3>
          Multi-chain support + BENJI (v2.0)
          <Status kind="in-progress" />
        </H3>
        <P>
          Pipeline built, surfacing pending. The multi-chain data pipeline is running
          across 22 fund-networks: BUIDL (8 chains), USTB (3) and USYC (3) are migrated,
          updated nightly and reconciled against on-chain supply; USDY (8 chains) and
          OUSG (4, including XRP Ledger) are still building state. Nothing multi-chain
          is surfaced on the site yet and the published methodology remains v1.1
          (Ethereum mainnet) &mdash; the aggregation rules are decided but ship together
          with the v2.0 recalibration. Franklin Templeton BENJI stays inactive: it still
          has no Ethereum deployment (Stellar/Polygon only).
        </P>
        <H3>Additional funds</H3>
        <P>
          Add new tokenized Treasury and money-market products as they launch.
          Candidates include emerging issuers and new BlackRock / Ondo product lines.
        </P>
        <H3>Restricted share class policy (v2.0)</H3>
        <P>
          Formalize the coverage rule for products with multiple on-chain share classes.
          BUIDL-I is currently excluded because 6 holders measure desk allocation, not
          adoption. v2.0 will define explicit coverage rules for products with multiple
          on-chain share classes and apply them consistently.
        </P>

        {/* Data quality */}
        <H2>Data Quality</H2>
        <H3>Live NAV prices</H3>
        <P>
          Replace the hardcoded <code className="text-xs bg-zinc-100 px-1 py-0.5 rounded">navUsd</code>{' '}
          values (refreshed monthly) with live per-fund price sources, now identified:
          USTB via Chainlink NAVLink, USYC via the Hashnote issuer price API, and
          OUSG/USDY via the Ondo oracle or CoinGecko (BUIDL holds a stable $1 NAV).
          Required for intra-month AUM accuracy.
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
