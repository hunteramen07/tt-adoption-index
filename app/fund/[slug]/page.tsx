import { notFound } from 'next/navigation'
import Link from 'next/link'
import { PRODUCTS_BY_SLUG } from '@/src/config/products'
import type { ProductSlug } from '@/src/config/products'
import { fetchFundData } from '@/src/lib/data/fund'
import { AumAreaChart } from '@/app/components/charts/AumAreaChart'
import { TopNSelector } from '@/app/components/TopNSelector'
import type { BehavioralMix } from '@/src/lib/classify/types'
import type { FundData } from '@/src/lib/data/fund'

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function fmtPct(n: number | null | undefined, d = 1): string {
  if (n == null) return '—'
  return `${n.toFixed(d)}%`
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US')
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

function fmtDatetime(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function truncateAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ─── Behavioral mix bar ───────────────────────────────────────────────────────

function MixBar({ mix }: { mix: BehavioralMix }) {
  const total = mix.total || 1
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`

  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden gap-px">
        {mix.accumulating > 0 && (
          <div className="bg-emerald-500" style={{ width: pct(mix.accumulating) }} />
        )}
        {mix.active > 0 && (
          <div className="bg-blue-500" style={{ width: pct(mix.active) }} />
        )}
        {mix.distributing > 0 && (
          <div className="bg-amber-400" style={{ width: pct(mix.distributing) }} />
        )}
        {mix.dormant > 0 && (
          <div className="bg-zinc-300" style={{ width: pct(mix.dormant) }} />
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {[
          { label: 'Accumulating', count: mix.accumulating, color: 'text-emerald-700' },
          { label: 'Active', count: mix.active, color: 'text-blue-700' },
          { label: 'Distributing', count: mix.distributing, color: 'text-amber-700' },
          { label: 'Dormant', count: mix.dormant, color: 'text-zinc-500' },
        ].map(({ label, count, color }) => (
          <div key={label} className="flex items-center justify-between">
            <span className={`font-medium ${color}`}>{label}</span>
            <span className="font-mono tabular-nums text-zinc-600">
              {fmtCount(count)}{' '}
              <span className="text-zinc-400">
                ({((count / total) * 100).toFixed(0)}%)
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const product = PRODUCTS_BY_SLUG[slug as ProductSlug]
  if (!product) return { title: 'Fund — RTA Index' }
  return { title: `${product.symbol} — RTA Index` }
}

export default async function FundPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const product = PRODUCTS_BY_SLUG[slug as ProductSlug]
  if (!product || product.active === false) notFound()

  const data: FundData | null = await fetchFundData(product.slug)

  if (!data) {
    return (
      <div className="min-h-screen bg-white text-zinc-900">
        <main className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
          <p className="text-sm text-zinc-400">
            Data unavailable for {product.symbol}. Please try again shortly.
          </p>
        </main>
      </div>
    )
  }

  const aumSeries = data.aumHistory?.series.map((p) => ({
    day: p.day,
    totalAum: p.aum,
  })) ?? []

  const latestAum = data.aumHistory?.latest?.aum ?? null
  const latestAumDay = data.aumHistory?.latest?.day ?? null

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-12">
        {/* ── Fund header ─────────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono text-sm font-semibold text-zinc-500 bg-zinc-100 px-2 py-0.5 rounded">
              {data.productSymbol}
            </span>
            <span className="text-xs text-zinc-400 bg-zinc-100 px-2 py-0.5 rounded-full">
              Ethereum
            </span>
          </div>
          <h1 className="text-xl font-semibold text-zinc-900">{data.productName}</h1>
          <p className="text-sm text-zinc-500 mt-0.5">{data.issuer}</p>
        </div>

        {/* ── Key stats ────────────────────────────────────────────────────── */}
        <section>
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-4">
            Key Metrics
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {/* AUM */}
            <div className="rounded border border-zinc-100 bg-zinc-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                AUM (Ethereum)
              </p>
              <p className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-zinc-900">
                {latestAum != null ? fmtUsd(latestAum) : '—'}
              </p>
              {latestAumDay && (
                <p className="mt-1 text-[11px] text-zinc-400">
                  as of {fmtMonthYear(latestAumDay)}
                </p>
              )}
            </div>

            {/* NAV */}
            <div className="rounded border border-zinc-100 bg-zinc-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                NAV / Token
              </p>
              <p className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-zinc-900">
                ${data.navUsd.toFixed(data.navUsd > 10 ? 2 : 4)}
              </p>
              {data.navAsOf ? (
                <p className="mt-1 text-[11px] text-zinc-400">
                  as of {fmtMonthYear(data.navAsOf)}
                </p>
              ) : (
                <p className="mt-1 text-[11px] text-zinc-400">stable $1</p>
              )}
            </div>

            {/* Holders */}
            <div className="rounded border border-zinc-100 bg-zinc-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Holders
              </p>
              <p className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-zinc-900">
                {fmtCount(data.holderCount)}
              </p>
              <p className="mt-1 text-[11px] text-zinc-400">distinct addresses</p>
            </div>

            {/* Concentration */}
            <div className="rounded border border-zinc-100 bg-zinc-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Concentration
              </p>
              <TopNSelector
                shares={data.topHolders.map((h) => h.shareOfSupply)}
                defaultN={5}
              />
              <p className="mt-1 text-[11px] text-zinc-400">
                of supply &middot; index uses Top-5
              </p>
            </div>

            {/* Dormancy */}
            <div className="rounded border border-zinc-100 bg-zinc-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Dormancy
              </p>
              <p className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-zinc-900">
                {fmtPct(data.dormancySharePct)}
              </p>
              <p className="mt-1 text-[11px] text-zinc-400">
                trailing 90d &middot; as of {fmtMonthYear(data.fetchedAt)}
              </p>
            </div>
          </div>

          {/* BUIDL share-class context */}
          {data.productSlug === 'buidl' && (
            <div className="mt-4 rounded border border-amber-100 bg-amber-50/40 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 mb-1">
                Share Class Coverage
              </p>
              <p className="text-xs text-zinc-600 leading-relaxed">
                This dashboard tracks the broadly-distributed BUIDL class (
                <a
                  href={`https://etherscan.io/token/${PRODUCTS_BY_SLUG.buidl.contractAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono hover:text-blue-600"
                >
                  0x7712&hellip;aA2AEC
                </a>
                , ~$181M, ~60 holders). BUIDL-I (0x6a96&hellip;c89041, ~$829M, 6 holders)
                is excluded &mdash; single-digit holders measure desk allocation, not
                broad market adoption. v2.0 coverage review planned.
              </p>
            </div>
          )}
        </section>

        {/* ── AUM history chart ─────────────────────────────────────────────── */}
        {aumSeries.length > 0 && (
          <section>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-4">
              AUM History
            </p>
            <div className="rounded border border-zinc-100 bg-white p-4">
              <AumAreaChart data={aumSeries} />
            </div>
            <p className="mt-3 text-xs text-zinc-400">
              Source: Dune Analytics (Ethereum mainnet supply &times; NAV)
            </p>
          </section>
        )}

        {/* ── Behavioral mix ────────────────────────────────────────────────── */}
        <section>
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-4">
            Holder Behavior
            <span className="ml-2 normal-case font-normal text-zinc-400">
              trailing 90 days
            </span>
          </p>
          {data.isAggregateOnly ? (
            <div className="rounded border border-zinc-100 bg-zinc-50 px-5 py-4">
              <MixBar mix={data.mix} />
              <p className="mt-3 text-[10px] text-zinc-400 italic">
                Aggregate flow statistics only — per-wallet classification is not
                available for USDY due to holder count and API constraints.
              </p>
            </div>
          ) : (
            <div className="rounded border border-zinc-100 bg-zinc-50 px-5 py-4 space-y-4">
              <MixBar mix={data.mix} />
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 pt-2 border-t border-zinc-100">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Net New Wallets (90d)
                  </p>
                  <p
                    className={`mt-0.5 text-lg font-mono font-semibold tabular-nums ${
                      data.netNewWallets90d >= data.exitedWallets90d
                        ? 'text-emerald-700'
                        : 'text-red-600'
                    }`}
                  >
                    {data.netNewWallets90d >= data.exitedWallets90d ? '+' : ''}
                    {fmtCount(data.netNewWallets90d - data.exitedWallets90d)}
                  </p>
                  <p className="text-[10px] text-zinc-400">
                    +{fmtCount(data.netNewWallets90d)} entered /
                    &minus;{fmtCount(data.exitedWallets90d)} exited
                  </p>
                </div>
                {data.netAccumulationRatio != null && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                      Accum. Ratio
                    </p>
                    <p className="mt-0.5 text-lg font-mono font-semibold tabular-nums text-zinc-800">
                      {(data.netAccumulationRatio * 100).toFixed(0)}%
                    </p>
                    <p className="text-[10px] text-zinc-400">
                      of directional wallets accumulating
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
          <p className="mt-3 text-xs text-zinc-400">
            Source: Supabase (classified holder data) &middot; as of{' '}
            {fmtTimestamp(data.fetchedAt)}
          </p>
        </section>

        {/* ── Top holders ───────────────────────────────────────────────────── */}
        <section>
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-4">
            Top Holders
          </p>
          <div className="overflow-x-auto rounded border border-zinc-100">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Address</th>
                  <th className="px-4 py-3 text-right">Share of Supply</th>
                  <th className="px-4 py-3 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {data.topHolders.map((h, i) => (
                  <tr
                    key={h.address}
                    className={i % 2 === 0 ? 'bg-white' : 'bg-zinc-50/50'}
                  >
                    <td className="px-4 py-3 text-xs text-zinc-400 tabular-nums">
                      {i + 1}
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        {h.nameTag ? (
                          <p className="text-sm font-medium text-zinc-800">
                            {h.nameTag}
                          </p>
                        ) : null}
                        <a
                          href={`https://etherscan.io/address/${h.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-zinc-400 hover:text-blue-600"
                        >
                          {truncateAddr(h.address)}
                        </a>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 bg-zinc-100 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full"
                            style={{ width: `${Math.min(h.shareOfSupply, 100)}%` }}
                          />
                        </div>
                        <span className="font-mono tabular-nums text-zinc-800 text-xs w-12 text-right">
                          {h.shareOfSupply.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-zinc-600">
                      {h.balanceFormatted}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.topHolders.length === 0 && (
            <p className="px-4 py-4 text-sm text-zinc-400 text-center">
              {data.isAggregateOnly
                ? 'Per-wallet data not available for this product.'
                : 'No holder data — run the classify script to populate.'}
            </p>
          )}
          <p className="mt-2 text-xs text-zinc-400">
            Balances from last classification run as of {fmtTimestamp(data.fetchedAt)}.
            Name tags from Etherscan contract labels; unlabeled addresses shown as truncated hex.
          </p>
        </section>

        {/* ── Recent large transfers ────────────────────────────────────────── */}
        {data.recentLargeTransfers.length > 0 && (
          <section>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-4">
              Recent Large Transfers
              <span className="ml-2 normal-case font-normal text-zinc-400">
                &gt;$1M
              </span>
            </p>
            <div className="overflow-x-auto rounded border border-zinc-100">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">From</th>
                    <th className="px-4 py-3">To</th>
                    <th className="px-4 py-3 text-right">Value (USD)</th>
                    <th className="px-4 py-3">Tx</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50">
                  {data.recentLargeTransfers.map((tx, i) => (
                    <tr
                      key={`${tx.hash}-${i}`}
                      className={i % 2 === 0 ? 'bg-white' : 'bg-zinc-50/50'}
                    >
                      <td className="px-4 py-3 text-xs text-zinc-500 whitespace-nowrap">
                        {fmtDatetime(tx.timestamp)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                            tx.isMint
                              ? 'bg-emerald-50 text-emerald-700'
                              : tx.isBurn
                              ? 'bg-red-50 text-red-600'
                              : 'bg-zinc-100 text-zinc-500'
                          }`}
                        >
                          {tx.isMint ? 'Mint' : tx.isBurn ? 'Burn' : 'Transfer'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {tx.isMint ? (
                          <span className="text-zinc-300 italic">—</span>
                        ) : (
                          <a
                            href={`https://etherscan.io/address/${tx.from}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-zinc-500 hover:text-blue-600"
                            title={tx.from}
                          >
                            {tx.fromName ?? truncateAddr(tx.from)}
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {tx.isBurn ? (
                          <span className="text-zinc-300 italic">—</span>
                        ) : (
                          <a
                            href={`https://etherscan.io/address/${tx.to}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-zinc-500 hover:text-blue-600"
                            title={tx.to}
                          >
                            {tx.toName ?? truncateAddr(tx.to)}
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-800 text-xs whitespace-nowrap">
                        {fmtUsd(tx.valueUsd)}
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={`https://etherscan.io/tx/${tx.hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] font-mono text-zinc-400 hover:text-blue-600"
                        >
                          {truncateAddr(tx.hash)}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-zinc-100 mt-10 px-4 sm:px-6 py-6">
        <div className="max-w-7xl mx-auto text-xs text-zinc-400">
          RTA Index &middot; Ethereum mainnet only &middot; Not financial advice
        </div>
      </footer>
    </div>
  )
}
