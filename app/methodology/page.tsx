import { METHODOLOGY_VERSION } from '@/src/config/index-ranges'

export const metadata = {
  title: 'Methodology — RTA Index',
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

export default function MethodologyPage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
        {/* Title */}
        <div className="mb-8">
          <h1 className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-1">
            Methodology
          </h1>
          <p className="text-lg font-semibold text-zinc-900">
            RWA Token Adoption Index (RTA Index) &mdash; v{METHODOLOGY_VERSION}
          </p>
        </div>

        {/* Purpose */}
        <H2>Purpose</H2>
        <P>
          A single 0&ndash;100 score measuring institutional adoption of tokenized
          real-world assets on public blockchains. Version 1 covers the tokenized
          U.S. Treasury / money market segment &mdash; the largest and most data-rich
          RWA category. Additional segments (private credit, commodities) are
          planned for future versions.
        </P>
        <P>
          A reading of 50 means adoption is flat; above 50, accelerating; below
          50, contracting.
        </P>

        {/* Covered products */}
        <H2>Covered Products (v1)</H2>
        <P>
          BlackRock BUIDL, Ondo OUSG, Ondo USDY, Superstate USTB, Hashnote USYC.
          Franklin Templeton BENJI is temporarily excluded from v1: it has no
          Ethereum mainnet deployment, and multi-chain support is planned for a
          future version.
        </P>

        {/* Factors */}
        <H2>Factors and Weights</H2>

        <div className="overflow-x-auto rounded border border-zinc-100 mb-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <th className="px-4 py-3 w-8">#</th>
                <th className="px-4 py-3">Factor</th>
                <th className="px-4 py-3 text-right whitespace-nowrap">Weight</th>
                <th className="px-4 py-3">Rationale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50 text-zinc-700">
              {[
                ['1', 'AUM growth (3-month)', '25%', 'Capital commitment is the primary evidence of adoption'],
                ['2', 'Holder growth (3-month)', '20%', 'Breadth of participation, not just size of capital'],
                ['3', 'Concentration trend (3-month)', '20%', 'Falling top-5 holder share distinguishes broad adoption from whale activity'],
                ['4', 'Dormancy trend (3-month)', '15%', 'Falling share of untouched supply means capital is being used, not parked'],
                ['5', 'Transfer activity', '10%', 'On-chain transfer volume relative to AUM; utilization velocity'],
                ['6', 'Breadth', '10%', 'Count of live products and chains; slow-moving structural signal'],
              ].map(([num, name, weight, rationale]) => (
                <tr key={num} className="odd:bg-white even:bg-zinc-50/50">
                  <td className="px-4 py-3 text-zinc-400">{num}</td>
                  <td className="px-4 py-3 font-medium text-zinc-800">{name}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">{weight}</td>
                  <td className="px-4 py-3 text-zinc-600">{rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Factor definitions */}
        <H2>Factor Definitions</H2>

        <H3>1. AUM Growth</H3>
        <P>
          3-month % change in total AUM across covered products. AUM = supply &times;
          per-product NAV. Distributing money-market products (BUIDL, USTB) hold ~$1
          NAV; accumulating products (OUSG at ~$115, USDY/USYC at ~$1.13) accrue
          yield into the token price. NAVs are hardcoded with a navAsOf date,
          refreshed monthly; live price sources are planned for a future version.
        </P>

        <H3>2. Holder Growth</H3>
        <P>
          3-month % change in total distinct holder addresses across covered products.
        </P>

        <H3>3. Concentration Trend</H3>
        <P>
          3-month change in the average top-5 holder share of supply, averaged across
          products. Declining share scores positively.
        </P>

        <H3>4. Dormancy Trend</H3>
        <P>
          3-month change in the share of total supply held by addresses with no
          outbound transfer in the trailing 90 days. Declining dormancy scores
          positively.
        </P>

        <H3>5. Transfer Activity</H3>
        <P>
          Trailing 30-day on-chain transfer volume divided by AUM, compared to its
          3-month average.
        </P>

        <H3>6. Breadth</H3>
        <P>
          Number of live products and distinct chains hosting them, scored against
          the trailing year.
        </P>

        {/* Normalization */}
        <H2>Normalization</H2>
        <P>
          Each factor maps to a 0&ndash;100 score via a defined linear range,
          clamped at the bounds (e.g., 3-month AUM growth: &minus;40% &rarr; 0,
          0% &rarr; 50, +65% &rarr; 100). Exact ranges per factor are calibrated
          against backfilled historical data so that the mature-phase distribution
          spans most of the 0&ndash;100 range, and are fixed in code thereafter.
          Range changes require a methodology version bump. Readings during the
          segment&apos;s launch phase (early 2023) reflect launch dynamics and clamp
          at scale bounds; the index is calibrated to the mature-phase distribution.
        </P>

        {/* Composite */}
        <H2>Composite</H2>
        <P>
          Weighted arithmetic mean of the six factor scores. Factor sub-scores are
          published alongside the composite. Computed monthly on the 1st for the prior
          month; readings stored as snapshots. Historical readings are backfilled from
          on-chain data.
        </P>

        {/* Holder behavior */}
        <H2>Holder Behavior Analysis</H2>
        <P>
          In addition to the index, the dashboard publishes wallet-level behavioral
          profiles. Each holder address is classified over the trailing 90 days as:
        </P>
        <ul className="text-sm text-zinc-600 space-y-1 list-disc list-inside mb-4 leading-relaxed">
          <li><strong>Accumulating</strong> &mdash; net inflows, no outflows in the window</li>
          <li><strong>Distributing</strong> &mdash; net outflows, no inflows in the window</li>
          <li><strong>Dormant</strong> &mdash; no movement (in or out) in the window</li>
          <li><strong>Active</strong> &mdash; both inflows and outflows in the window (two-way flow)</li>
        </ul>
        <P>
          Published aggregates: behavioral mix per product, average holding period,
          dormancy share, net new vs. exited wallets per month.
        </P>
        <P>
          Coverage tiers: full per-wallet classification for institutional products
          (BUIDL, OUSG, USTB, USYC); aggregate flow statistics only for USDY due to
          holder count and API constraints.
        </P>
        <P>
          These profile metrics inform the Dormancy factor but the full behavioral mix
          is not an index input in v1.0.
        </P>

        {/* Limitations */}
        <H2>Limitations</H2>
        <ul className="text-sm text-zinc-600 space-y-2 list-disc list-inside mb-4 leading-relaxed">
          <li>
            <strong>Custodial wallets:</strong> each address is treated as one holder.
            Omnibus custodial structures may aggregate many beneficial owners,
            overstating concentration and dormancy. Publicly labeled addresses
            (exchanges, known custodians) are flagged where available.
          </li>
          <li>
            <strong>Ethereum mainnet only:</strong>{' '}v1 measures Ethereum mainnet
            adoption only. Ethereum&apos;s share of total product AUM ranges from ~3%
            (USYC) to ~51% (USDY) per rwa.xyz, so the index reflects
            Ethereum-chain adoption specifically. Multi-chain coverage is the
            next coverage expansion.
          </li>
          <li>
            <strong>Per-token classification:</strong>{' '}behavioral labels reflect flows
            of each token in isolation. Holders interacting with DeFi wrappers
            (e.g., Flux Finance&apos;s fOUSG for OUSG) may be classified as
            Distributing or Accumulating while their economic exposure is unchanged.
            Wrapper-aware classification is a candidate for future versions.
          </li>
          <li>
            The index measures on-chain observable adoption; off-chain records
            (transfer-agent ledgers) are out of scope.
          </li>
        </ul>

        {/* Data sources */}
        <H2>Data Sources</H2>
        <P>
          Etherscan (holders, concentration, transfers, behavioral classification),
          Dune Analytics (supply/AUM history), issuer disclosures (minimums,
          eligibility, NAV).
        </P>

        {/* Eligibility */}
        <H2>Primary Market Access &amp; Eligibility</H2>
        <P>
          Minimum investment and eligibility as stated by issuers, June 2026.
          Secondary market availability varies.
        </P>

        <div className="overflow-x-auto rounded border border-zinc-100 mb-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <th className="px-4 py-3">Fund</th>
                <th className="px-4 py-3 whitespace-nowrap">Min. Investment</th>
                <th className="px-4 py-3">Eligibility</th>
                <th className="px-4 py-3">Platform</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50 text-zinc-700">
              {[
                {
                  symbol: 'BUIDL',
                  min: '$5M',
                  elig: 'Qualified Purchasers',
                  platform: 'Securitize BUIDL Portal',
                },
                {
                  symbol: 'OUSG',
                  min: '$5K (instant) / $100K (standard)',
                  elig: 'Accredited Investors & Qualified Purchasers',
                  platform: 'Ondo Finance',
                },
                {
                  symbol: 'USDY',
                  min: '$5K',
                  elig: 'Non-US individuals & organizations',
                  platform: 'Ondo Finance',
                },
                {
                  symbol: 'USTB',
                  min: '$100K',
                  elig: 'Qualified Purchasers & Accredited Investors',
                  platform: 'Superstate',
                },
                {
                  symbol: 'USYC',
                  min: '$100K',
                  elig: 'Non-US institutional',
                  platform: 'Circle USYC / Hashnote Portal',
                },
              ].map(({ symbol, min, elig, platform }) => (
                <tr key={symbol} className="odd:bg-white even:bg-zinc-50/50">
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs font-semibold text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded">
                      {symbol}
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{min}</td>
                  <td className="px-4 py-3 text-zinc-600">{elig}</td>
                  <td className="px-4 py-3 text-zinc-600">{platform}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-zinc-400 mb-8">
          Primary market access as stated by issuers, June 2026; secondary market
          availability varies.
        </p>

        {/* Versioning */}
        <H2>Versioning</H2>
        <div className="space-y-3 text-sm text-zinc-600 border-l-2 border-zinc-100 pl-4">
          <div>
            <p className="font-semibold text-zinc-800">v1.0 &mdash; June 10, 2026</p>
            <p>
              Initial release. Factor additions, weight changes, or range
              recalibrations increment the version and are documented here.
            </p>
          </div>
          <div>
            <p className="font-semibold text-zinc-800">v1.1 &mdash; June 11, 2026</p>
            <p>
              Dormancy aggregation corrected from simple product average to
              supply-weighted share of total segment supply, matching the original
              factor definition (&ldquo;share of total supply held by addresses with
              no outbound transfer in the trailing 90 days&rdquo;). Historical
              readings restated.
            </p>
          </div>
        </div>
      </main>

      <footer className="border-t border-zinc-100 mt-10 px-4 sm:px-6 py-6">
        <div className="max-w-7xl mx-auto text-xs text-zinc-400">
          RTA Index &middot; Ethereum mainnet only &middot; Not financial advice
        </div>
      </footer>
    </div>
  )
}
