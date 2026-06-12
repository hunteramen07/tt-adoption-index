import { connection } from 'next/server'
import { ACTIVE_PRODUCTS } from '@/src/config/products'
import { METHODOLOGY_VERSION } from '@/src/config/index-ranges'
import { fetchIndexHistory } from '@/src/lib/index/history'
import { fetchAumHistory } from '@/src/lib/dune/supplyHistory'
import { fetchProductStats } from '@/src/lib/data/homepage'
import type { IndexHistoryRow } from '@/src/lib/index/history'
import type { ProductStats } from '@/src/lib/data/homepage'
import type { AumHistoryResult } from '@/src/lib/dune/supplyHistory'
import { Sparkline } from './components/charts/Sparkline'
import { AumAreaChart } from './components/charts/AumAreaChart'

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return `${(n * 100).toFixed(decimals)}%`
}

function fmtCount(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString('en-US')
}

function fmtShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function fmtMonthYear(isoDate: string): string {
  return new Date(isoDate + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  })
}

function fmtTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  })
}

// ─── Factor metadata ─────────────────────────────────────────────────────────

const FACTOR_META = {
  aumGrowth3m: { label: 'AUM Growth', sublabel: '3-month', weight: 0.25 },
  holderGrowth3m: { label: 'Holder Growth', sublabel: '3-month', weight: 0.20 },
  concentrationDelta3m: { label: 'Concentration', sublabel: '3-month trend', weight: 0.20 },
  dormancyDelta3m: { label: 'Dormancy', sublabel: '3-month trend', weight: 0.15 },
  transferActivityRatio: { label: 'Transfer Activity', sublabel: '30d vs 3m avg', weight: 0.10 },
  breadth: { label: 'Breadth', sublabel: 'products + chains', weight: 0.10 },
} as const

type FactorKey = keyof typeof FACTOR_META

function fmtFactorRaw(key: FactorKey, raw: number): string {
  switch (key) {
    case 'aumGrowth3m':
    case 'holderGrowth3m':
      return raw >= 0 ? `+${(raw * 100).toFixed(1)}%` : `${(raw * 100).toFixed(1)}%`
    case 'concentrationDelta3m':
    case 'dormancyDelta3m':
      return raw >= 0 ? `+${(raw * 100).toFixed(1)}pp` : `${(raw * 100).toFixed(1)}pp`
    case 'transferActivityRatio':
      return `×${raw.toFixed(2)}`
    case 'breadth':
      return `${Math.round(raw)}`
  }
}

// ─── AUM time series ─────────────────────────────────────────────────────────

function buildAumTimeSeries(
  aumResult: AumHistoryResult
): { day: string; totalAum: number }[] {
  const dayMap = new Map<string, number>()
  for (const hist of Object.values(aumResult.products)) {
    if (!hist) continue
    for (const pt of hist.series) {
      dayMap.set(pt.day, (dayMap.get(pt.day) ?? 0) + pt.aum)
    }
  }
  return Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, totalAum]) => ({ day, totalAum }))
}

// ─── Source footer ────────────────────────────────────────────────────────────

function SourceLine({
  source,
  fetchedAt,
}: {
  source: string
  fetchedAt: string | null
}) {
  return (
    <p className="mt-3 text-xs text-zinc-400">
      Source: {source}
      {fetchedAt && (
        <>
          {' '}
          &middot; Refreshed {fmtTimestamp(fetchedAt)}
        </>
      )}
    </p>
  )
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
        {title}
      </h2>
      {subtitle && <p className="text-sm text-zinc-500 mt-0.5">{subtitle}</p>}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default async function Home() {
  await connection()
  // Parallel fetch: index history, Dune AUM, and per-product live stats
  const [indexResult, aumResult, ...productStatsResults] = await Promise.all([
    fetchIndexHistory(),
    fetchAumHistory(),
    ...ACTIVE_PRODUCTS.map((p) => fetchProductStats(p)),
  ])

  const indexRows: IndexHistoryRow[] = indexResult?.rows ?? []
  const latest: IndexHistoryRow | null = indexRows.at(-1) ?? null
  const prevMonth: IndexHistoryRow | null = indexRows.at(-2) ?? null

  const scoreDelta =
    latest && prevMonth ? latest.composite - prevMonth.composite : null

  // Per-product stats map
  const statsMap = new Map<string, ProductStats>()
  for (let i = 0; i < ACTIVE_PRODUCTS.length; i++) {
    const s = productStatsResults[i]
    if (s) statsMap.set(s.productSlug, s)
  }

  // Summary aggregates
  let totalAum = 0
  let totalHolders = 0
  let dormancyWeightedSum = 0
  let dormancyAumTotal = 0

  for (const product of ACTIVE_PRODUCTS) {
    const hist = aumResult?.products[product.slug]
    const productAum = hist?.latest?.aum ?? 0
    if (productAum > 0) totalAum += productAum

    const stats = statsMap.get(product.slug)
    if (stats) {
      totalHolders += stats.holderCount
      if (productAum > 0) {
        dormancyWeightedSum += stats.dormancyShare * productAum
        dormancyAumTotal += productAum
      }
    }
  }

  const avgDormancy = dormancyAumTotal > 0 ? dormancyWeightedSum / dormancyAumTotal : null
  const aumTimeSeries = aumResult ? buildAumTimeSeries(aumResult) : []

  const sparklineData = indexRows.map((r) => ({
    day: r.readingDate,
    composite: r.composite,
  }))

  // Determine freshest etherscan fetch time
  const etherFetchedAt =
    productStatsResults.find((s) => s?.fetchedAt)?.fetchedAt ?? null

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-14">
        {/* ══ Section 1: The 30-second view ═══════════════════════════════ */}
        <section>
          <SectionHeader
            title="The 30-Second View"
            subtitle="Composite score of institutional adoption of tokenized U.S. Treasuries"
          />

          {latest ? (
            <>
              {/* Index hero row */}
              <div className="flex flex-col sm:flex-row sm:items-end gap-6 sm:gap-10">
                {/* Score + change */}
                <div className="flex-none">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-7xl font-light tracking-tight text-zinc-900 tabular-nums leading-none">
                      {latest.composite.toFixed(1)}
                    </span>
                    <span className="text-sm text-zinc-400 font-medium uppercase tracking-wider leading-none mb-1">
                      / 100
                    </span>
                  </div>

                  <div className="mt-2 flex items-center gap-3">
                    {scoreDelta !== null ? (
                      <span
                        className={`text-sm font-medium tabular-nums ${
                          scoreDelta >= 0 ? 'text-emerald-700' : 'text-red-600'
                        }`}
                      >
                        {scoreDelta >= 0 ? '▲' : '▼'}{' '}
                        {scoreDelta >= 0 ? '+' : ''}
                        {scoreDelta.toFixed(1)} vs{' '}
                        {fmtMonthYear(prevMonth!.readingDate)}
                      </span>
                    ) : (
                      <span className="text-sm text-zinc-400">No prior reading</span>
                    )}

                    {latest.isPartial && (
                      <span
                        className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200"
                        title={latest.partialReason ?? 'Partial reading'}
                      >
                        Partial
                      </span>
                    )}
                  </div>

                  <p className="mt-1 text-xs text-zinc-400">
                    {fmtMonthYear(latest.readingDate)} reading &middot; v{latest.methodologyVersion}
                  </p>
                </div>

                {/* Sparkline */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-zinc-400 uppercase tracking-wider">
                      Index history
                    </span>
                    <span className="text-xs text-zinc-400">
                      {indexRows.length} reading{indexRows.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <Sparkline data={sparklineData} />
                </div>
              </div>

              {/* Factor grid */}
              <div className="mt-8 grid grid-cols-2 md:grid-cols-3 gap-3">
                {(Object.keys(FACTOR_META) as FactorKey[]).map((key) => {
                  const meta = FACTOR_META[key]
                  const factor = latest.factors[key]
                  const score = factor?.score
                  const raw = factor?.raw

                  return (
                    <div
                      key={key}
                      className="rounded border border-zinc-100 bg-zinc-50 px-4 py-3"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <p className="text-xs font-semibold text-zinc-700">
                            {meta.label}
                          </p>
                          <p className="text-[10px] text-zinc-400">{meta.sublabel}</p>
                        </div>
                        <span className="text-[10px] font-medium text-zinc-400 bg-zinc-200 px-1.5 py-0.5 rounded-full">
                          {Math.round(meta.weight * 100)}%
                        </span>
                      </div>

                      {score !== undefined ? (
                        <>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-xl font-mono font-semibold text-zinc-800 tabular-nums">
                              {score.toFixed(0)}
                            </span>
                            {raw !== undefined && (
                              <span className="text-[10px] text-zinc-400 font-mono">
                                ({fmtFactorRaw(key, raw)})
                              </span>
                            )}
                          </div>
                          {/* Score bar */}
                          <div className="mt-2 h-1 rounded-full bg-zinc-200 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-blue-600"
                              style={{ width: `${Math.max(2, score)}%` }}
                            />
                          </div>
                        </>
                      ) : (
                        <p className="text-sm text-zinc-300 mt-1">—</p>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="rounded border border-zinc-100 bg-zinc-50 px-6 py-8 text-center text-sm text-zinc-400">
              No index readings available yet
            </div>
          )}

          <SourceLine source="Supabase (index_readings)" fetchedAt={indexResult?.fetchedAt ?? null} />
        </section>

        {/* ══ Section 2: Summary stat cards ═══════════════════════════════ */}
        <section>
          <SectionHeader title="Market Overview" />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Total AUM"
              value={totalAum > 0 ? fmtUsd(totalAum) : '—'}
              sub="Ethereum mainnet, NAV-adjusted"
            />
            <StatCard
              label="Total Holders"
              value={totalHolders > 0 ? fmtCount(totalHolders) : '—'}
              sub="Distinct addresses with positive balance"
            />
            <StatCard
              label="Avg Dormancy"
              value={fmtPct(avgDormancy)}
              sub={`Trailing 90d${etherFetchedAt ? `, as of ${fmtShortDate(etherFetchedAt)}` : ''} · Live`}
              note="Index dormancy factor uses month-end snapshots"
            />
            <StatCard
              label="Active Products"
              value={String(ACTIVE_PRODUCTS.length)}
              sub="Ethereum mainnet (v1 coverage)"
            />
          </div>

          <SourceLine
            source="Dune Analytics · Etherscan"
            fetchedAt={aumResult?.fetchedAt ?? etherFetchedAt}
          />
        </section>

        {/* ══ Section 3: Fund table ════════════════════════════════════════ */}
        <section>
          <SectionHeader
            title="Products"
            subtitle="Tokenized U.S. Treasury funds tracked on Ethereum mainnet"
          />

          <div className="overflow-x-auto rounded border border-zinc-100">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <th className="px-4 py-3 whitespace-nowrap">Fund</th>
                  <th className="px-4 py-3 whitespace-nowrap">Issuer</th>
                  <th className="px-4 py-3 whitespace-nowrap text-right">
                    AUM (Eth)
                  </th>
                  <th className="px-4 py-3 whitespace-nowrap text-right">NAV</th>
                  <th className="px-4 py-3 whitespace-nowrap text-right">
                    Holders
                  </th>
                  <th className="px-4 py-3 whitespace-nowrap text-right">
                    Top-5 Share
                  </th>
                  <th className="px-4 py-3 whitespace-nowrap text-right">
                    Dormancy
                  </th>
                  <th className="px-4 py-3 whitespace-nowrap">Chain</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {ACTIVE_PRODUCTS.map((product, i) => {
                  const hist = aumResult?.products[product.slug]
                  const aum = hist?.latest?.aum ?? null
                  const aumAsOf = hist?.latest?.day ?? null
                  const stats = statsMap.get(product.slug)

                  return (
                    <tr
                      key={product.slug}
                      className={`${
                        i % 2 === 0 ? 'bg-white' : 'bg-zinc-50/50'
                      } hover:bg-blue-50/30 transition-colors`}
                    >
                      {/* Fund */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded">
                            {product.symbol}
                          </span>
                          <span
                            className="text-zinc-800 font-medium truncate max-w-[180px]"
                            title={product.name}
                          >
                            {product.name}
                          </span>
                        </div>
                      </td>

                      {/* Issuer */}
                      <td className="px-4 py-3 whitespace-nowrap text-zinc-600">
                        {product.issuer}
                      </td>

                      {/* AUM */}
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        {aum != null ? (
                          <div>
                            <span className="font-mono tabular-nums text-zinc-800">
                              {fmtUsd(aum)}
                            </span>
                            {aumAsOf && (
                              <p className="text-[10px] text-zinc-400">
                                as of {fmtMonthYear(aumAsOf)}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </td>

                      {/* NAV */}
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        <div>
                          <span className="font-mono tabular-nums text-zinc-800">
                            ${(product.navUsd ?? 1).toFixed(product.navUsd && product.navUsd > 10 ? 2 : 4)}
                          </span>
                          {product.navAsOf ? (
                            <p className="text-[10px] text-zinc-400">
                              as of {fmtMonthYear(product.navAsOf)}
                            </p>
                          ) : (
                            <p className="text-[10px] text-zinc-400">stable $1</p>
                          )}
                        </div>
                      </td>

                      {/* Holders */}
                      <td className="px-4 py-3 whitespace-nowrap text-right font-mono tabular-nums text-zinc-700">
                        {stats ? fmtCount(stats.holderCount) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </td>

                      {/* Top-5 share */}
                      <td className="px-4 py-3 whitespace-nowrap text-right font-mono tabular-nums text-zinc-700">
                        {stats ? fmtPct(stats.top5Share) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </td>

                      {/* Dormancy */}
                      <td className="px-4 py-3 whitespace-nowrap text-right font-mono tabular-nums text-zinc-700">
                        {stats ? fmtPct(stats.dormancyShare) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </td>

                      {/* Chain */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="text-xs text-zinc-500 bg-zinc-100 px-2 py-0.5 rounded-full">
                          Ethereum
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-2 text-xs text-zinc-400">
            † AUM figures reflect Ethereum mainnet supply only. BUIDL, OUSG, USDY, USTB, and USYC are
            deployed across multiple chains; multi-chain coverage is deferred to v1.1. NAV prices are
            hardcoded and refreshed monthly — see{' '}
            <a href="/methodology" className="underline hover:text-zinc-600">
              methodology
            </a>
            .
          </p>

          <SourceLine
            source="Dune Analytics (supply) · Etherscan (holders)"
            fetchedAt={aumResult?.fetchedAt ?? etherFetchedAt}
          />
        </section>

        {/* ══ Section 4: Total AUM over time ══════════════════════════════ */}
        <section>
          <SectionHeader
            title="Total AUM Over Time"
            subtitle="Sum of NAV-adjusted on-chain supply across all tracked products (Ethereum mainnet)"
          />

          {aumTimeSeries.length > 0 ? (
            <div className="rounded border border-zinc-100 bg-white p-4">
              <AumAreaChart data={aumTimeSeries} />
            </div>
          ) : (
            <div className="rounded border border-zinc-100 bg-zinc-50 px-6 py-8 text-center text-sm text-zinc-400">
              No AUM history available
            </div>
          )}

          <SourceLine
            source="Dune Analytics (query 7696914)"
            fetchedAt={aumResult?.fetchedAt ?? null}
          />
        </section>
      </main>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="border-t border-zinc-100 mt-16 px-4 sm:px-6 py-6">
        <div className="max-w-7xl mx-auto text-xs text-zinc-400 space-y-1">
          <p>
            RTA Index v{METHODOLOGY_VERSION} &middot; Methodology version {METHODOLOGY_VERSION} &middot; Ethereum mainnet
            only
          </p>
          <p>
            Data sources: Etherscan (holders, transfers), Dune Analytics (supply
            history), Supabase (index snapshots). Not financial advice.
          </p>
        </div>
      </footer>
    </div>
  )
}

// ─── Stat card component ──────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  note,
}: {
  label: string
  value: string
  sub: string
  note?: string
}) {
  return (
    <div className="rounded border border-zinc-100 bg-zinc-50 px-4 py-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-zinc-900">
        {value}
      </p>
      <p className="mt-1 text-[11px] text-zinc-400 leading-snug">{sub}</p>
      {note && (
        <p className="mt-1 text-[10px] text-zinc-300 italic leading-snug">{note}</p>
      )}
    </div>
  )
}
