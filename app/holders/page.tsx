import { connection } from 'next/server'
import { fetchHoldersBehavior } from '@/src/lib/data/holders'
import type { ProductBehaviorData } from '@/src/lib/data/holders'
import type { BehavioralMix } from '@/src/lib/classify/types'
import Link from 'next/link'

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined, d = 1): string {
  if (n == null) return '—'
  return `${n.toFixed(d)}%`
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US')
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

// ─── Behavioral mix bar ───────────────────────────────────────────────────────

function MixBar({ mix }: { mix: BehavioralMix }) {
  const { accumulating, distributing, dormant, active, total } = mix
  if (total === 0) return <div className="h-2 rounded-full bg-zinc-100" />

  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`

  return (
    <div className="flex h-2 rounded-full overflow-hidden gap-px">
      {accumulating > 0 && (
        <div
          className="bg-emerald-500"
          style={{ width: pct(accumulating) }}
          title={`Accumulating: ${pct(accumulating)}`}
        />
      )}
      {active > 0 && (
        <div
          className="bg-blue-500"
          style={{ width: pct(active) }}
          title={`Active: ${pct(active)}`}
        />
      )}
      {distributing > 0 && (
        <div
          className="bg-amber-400"
          style={{ width: pct(distributing) }}
          title={`Distributing: ${pct(distributing)}`}
        />
      )}
      {dormant > 0 && (
        <div
          className="bg-zinc-300"
          style={{ width: pct(dormant) }}
          title={`Dormant: ${pct(dormant)}`}
        />
      )}
    </div>
  )
}

// ─── Product card ─────────────────────────────────────────────────────────────

function ProductCard({ data }: { data: ProductBehaviorData }) {
  const { mix } = data
  const total = mix.total || 1

  const behaviors: { label: string; count: number; color: string }[] = [
    { label: 'Accumulating', count: mix.accumulating, color: 'text-emerald-700' },
    { label: 'Active', count: mix.active, color: 'text-blue-700' },
    { label: 'Distributing', count: mix.distributing, color: 'text-amber-700' },
    { label: 'Dormant', count: mix.dormant, color: 'text-zinc-500' },
  ]

  return (
    <div className="rounded border border-zinc-100 bg-white p-5 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-mono text-xs font-semibold text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded">
              {data.productSymbol}
            </span>
            {data.isAggregateOnly && (
              <span className="text-[10px] font-medium text-zinc-400 bg-zinc-50 border border-zinc-200 px-1.5 py-0.5 rounded">
                aggregate only
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-zinc-800 leading-tight">
            {data.productName}
          </p>
        </div>
        <Link
          href={`/fund/${data.productSlug}`}
          className="text-xs text-blue-600 hover:text-blue-800 shrink-0"
        >
          Details &rarr;
        </Link>
      </div>

      {/* Stacked bar */}
      <MixBar mix={mix} />

      {/* Behavior breakdown */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {behaviors.map(({ label, count, color }) => (
          <div key={label} className="flex items-center justify-between">
            <span className={`text-xs font-medium ${color}`}>{label}</span>
            <span className="text-xs font-mono tabular-nums text-zinc-600">
              {fmtCount(count)}{' '}
              <span className="text-zinc-400">
                ({((count / total) * 100).toFixed(0)}%)
              </span>
            </span>
          </div>
        ))}
      </div>

      {/* Key metrics */}
      <div className="pt-3 border-t border-zinc-50 grid grid-cols-3 gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Holders
          </p>
          <p className="mt-0.5 text-base font-mono font-semibold tabular-nums text-zinc-800">
            {fmtCount(data.holderCount)}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Dormancy
          </p>
          <p className="mt-0.5 text-base font-mono font-semibold tabular-nums text-zinc-800">
            {data.dormancySharePct === null ? (
              <span className="text-zinc-400 text-sm font-sans font-normal">multi-chain · pending</span>
            ) : (
              fmtPct(data.dormancySharePct)
            )}
          </p>
          <p className="text-[10px] text-zinc-400">
            {data.dormancySharePct === null ? 'supply-weighted across chains — Phase 2' : 'of supply'}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Net New (90d)
          </p>
          <p
            className={`mt-0.5 text-base font-mono font-semibold tabular-nums ${
              data.netNewWallets90d >= data.exitedWallets90d
                ? 'text-emerald-700'
                : 'text-red-600'
            }`}
          >
            {data.netNewWallets90d >= data.exitedWallets90d ? '+' : ''}
            {fmtCount(data.netNewWallets90d - data.exitedWallets90d)}
          </p>
          <p className="text-[10px] text-zinc-400">
            +{fmtCount(data.netNewWallets90d)} / &minus;{fmtCount(data.exitedWallets90d)}
          </p>
        </div>
      </div>

      {data.isAggregateOnly && (
        <p className="text-[10px] text-zinc-400 italic leading-snug">
          USDY has a high holder count and uses aggregate flow statistics only.
          Per-wallet classification is not available. See{' '}
          <Link href="/methodology" className="underline">
            methodology
          </Link>
          .
        </p>
      )}
    </div>
  )
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-500">
      {[
        { color: 'bg-emerald-500', label: 'Accumulating — net inflow, no outflow' },
        { color: 'bg-blue-500', label: 'Active — two-way flow' },
        { color: 'bg-amber-400', label: 'Distributing — net outflow, no inflow' },
        { color: 'bg-zinc-300', label: 'Dormant — no movement in 90d' },
      ].map(({ color, label }) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className={`inline-block w-2.5 h-2.5 rounded-sm ${color}`} />
          {label}
        </span>
      ))}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export const metadata = {
  title: 'Holder Behavior — RTA Index',
}

export default async function HoldersPage() {
  await connection()
  const result = await fetchHoldersBehavior()

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-10">
        {/* Page header */}
        <div>
          <h1 className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-1">
            Holder Behavior
          </h1>
          <p className="text-sm text-zinc-500 max-w-2xl">
            Wallet-level behavioral profiles over the trailing 90-day window.
            Each address is classified as Accumulating, Active, Distributing, or Dormant
            based on its inflow and outflow patterns.
          </p>
        </div>

        <Legend />

        {result ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {result.products.map((data) => (
              <ProductCard key={data.productSlug} data={data} />
            ))}
          </div>
        ) : (
          <div className="rounded border border-zinc-100 bg-zinc-50 px-6 py-8 text-center text-sm text-zinc-400">
            Holder behavior data unavailable
          </div>
        )}

        {/* Methodology notes */}
        <section className="rounded border border-zinc-100 bg-zinc-50 px-5 py-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Coverage &amp; Limitations
          </p>
          <ul className="text-xs text-zinc-500 space-y-1 list-disc list-inside leading-relaxed">
            <li>
              <strong>Custodial wallets:</strong> omnibus custodians aggregate many
              beneficial owners behind one address, overstating dormancy and concentration
              for those holders.
            </li>
            <li>
              <strong>DeFi wrappers:</strong> holders interacting with wrappers (e.g., Flux
              Finance fOUSG for OUSG) may appear as Distributing while their economic
              exposure is unchanged.
            </li>
            <li>
              <strong>Ethereum mainnet only:</strong> multi-chain holders on Solana, Polygon,
              XRP Ledger, etc. are not captured in v1.
            </li>
            <li>
              <strong>USDY aggregate only:</strong> high holder count prevents per-wallet
              classification. Aggregate flow statistics from the classification pipeline are
              shown; per-wallet breakdown is not available.
            </li>
          </ul>
          <p className="text-xs text-zinc-400">
            See{' '}
            <Link href="/methodology" className="underline hover:text-zinc-600">
              methodology
            </Link>{' '}
            for full definitions.
          </p>
        </section>

        {/* Source line */}
        {result && (
          <p className="text-xs text-zinc-400">
            Source: Supabase (classified holder data) &middot; as of{' '}
            {fmtTimestamp(result.fetchedAt)}
          </p>
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
