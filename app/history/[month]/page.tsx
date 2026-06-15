import { connection } from 'next/server'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { fetchIndexHistory } from '@/src/lib/index/history'
import type { IndexHistoryRow } from '@/src/lib/index/history'
import { metaFor, orderFactorKeys, fmtFactorRaw } from '@/src/lib/index/factor-meta'

function fmtMonthYear(isoDate: string): string {
  return new Date(isoDate + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ month: string }>
}) {
  const { month } = await params
  return { title: `${fmtMonthYear(month)} — RTA Index` }
}

export default async function MonthDetailPage({
  params,
}: {
  params: Promise<{ month: string }>
}) {
  await connection()
  const { month } = await params

  const result = await fetchIndexHistory()
  const rows: IndexHistoryRow[] = result?.rows ?? []
  const idx = rows.findIndex((r) => r.readingDate === month)
  if (idx === -1) notFound()

  const reading = rows[idx]
  const prev = idx > 0 ? rows[idx - 1] : null
  const delta = prev ? reading.composite - prev.composite : null

  // Schema-flexible: render whatever factors exist on this reading.
  const presentKeys = orderFactorKeys(
    Object.keys(reading.factors).filter(
      (k) => reading.factors[k as keyof typeof reading.factors] !== undefined
    )
  )

  // Sum of weights of *present* factors — composite is the weighted mean over
  // available factors, so contributions are normalized by this, not by 1.0.
  const presentWeightSum = presentKeys.reduce((s, k) => s + metaFor(k).weight, 0)

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
        {/* Back link */}
        <Link
          href="/history"
          className="text-xs font-medium text-zinc-400 hover:text-zinc-700"
        >
          ← All readings
        </Link>

        {/* Header */}
        <div className="mt-4 mb-8">
          <h1 className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-1">
            {fmtMonthYear(reading.readingDate)}
          </h1>
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-6xl font-light tracking-tight tabular-nums leading-none">
              {reading.composite.toFixed(1)}
            </span>
            <span className="text-sm text-zinc-400 font-medium uppercase tracking-wider mb-1">
              / 100
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            {delta !== null ? (
              <span
                className={`text-sm font-medium tabular-nums ${
                  delta >= 0 ? 'text-emerald-700' : 'text-red-600'
                }`}
              >
                {delta >= 0 ? '▲ +' : '▼ '}
                {delta.toFixed(1)} vs {fmtMonthYear(prev!.readingDate)}
              </span>
            ) : (
              <span className="text-sm text-zinc-400">No prior reading</span>
            )}
            <span className="text-xs text-zinc-400">v{reading.methodologyVersion}</span>
          </div>
        </div>

        {/* Partial note */}
        {reading.isPartial && (
          <div className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide">
              Partial reading
            </p>
            <p className="mt-1 text-sm text-amber-700">
              {reading.partialReason ??
                'One or more factors could not be computed for this month.'}
            </p>
          </div>
        )}

        {/* Factor breakdown */}
        <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-3">
          Factor Breakdown
        </h2>
        <div className="overflow-hidden rounded border border-zinc-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <th className="px-4 py-3">Factor</th>
                <th className="px-4 py-3 text-right">Raw</th>
                <th className="px-4 py-3 text-right">Score</th>
                <th className="px-4 py-3 text-right">Weight</th>
                <th className="px-4 py-3 text-right">Contribution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {presentKeys.map((key) => {
                const meta = metaFor(key)
                const factor = reading.factors[key as keyof typeof reading.factors]
                const score = factor?.score
                const raw = factor?.raw
                // Effective weight within available factors.
                const effWeight = presentWeightSum > 0 ? meta.weight / presentWeightSum : 0
                const contribution =
                  score !== undefined ? score * effWeight : undefined

                return (
                  <tr key={key} className="bg-white">
                    <td className="px-4 py-3">
                      <p className="font-medium text-zinc-800">{meta.label}</p>
                      {meta.sublabel && (
                        <p className="text-[11px] text-zinc-400">{meta.sublabel}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-600">
                      {raw !== undefined ? fmtFactorRaw(key, raw) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-zinc-800">
                      {score !== undefined ? score.toFixed(1) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-500">
                      {Math.round(meta.weight * 100)}%
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-600">
                      {contribution !== undefined ? contribution.toFixed(1) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="bg-zinc-50 font-semibold">
                <td className="px-4 py-3 text-zinc-700" colSpan={4}>
                  Composite
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-900">
                  {reading.composite.toFixed(1)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p className="mt-3 text-xs text-zinc-400 leading-relaxed">
          Score is each factor&apos;s raw value normalized to 0–100 (50 = flat).
          Contribution is the score weighted by its share among the factors available
          this month{reading.isPartial ? ' (re-weighted because this reading is partial)' : ''};
          contributions sum to the composite. Full factor definitions and normalization
          ranges are on the{' '}
          <Link href="/methodology" className="underline hover:text-zinc-600">
            methodology page
          </Link>
          .
        </p>

        {/* Prev / next navigation */}
        <div className="mt-8 flex justify-between text-sm">
          {idx > 0 ? (
            <Link
              href={`/history/${rows[idx - 1].readingDate}`}
              className="text-blue-700 hover:underline"
            >
              ← {fmtMonthYear(rows[idx - 1].readingDate)}
            </Link>
          ) : (
            <span />
          )}
          {idx < rows.length - 1 ? (
            <Link
              href={`/history/${rows[idx + 1].readingDate}`}
              className="text-blue-700 hover:underline"
            >
              {fmtMonthYear(rows[idx + 1].readingDate)} →
            </Link>
          ) : (
            <span />
          )}
        </div>
      </main>

      <footer className="border-t border-zinc-100 mt-16 px-4 sm:px-6 py-6">
        <div className="max-w-7xl mx-auto text-xs text-zinc-400">
          RTA Index v{reading.methodologyVersion} &middot; Ethereum mainnet only &middot; Not financial advice
        </div>
      </footer>
    </div>
  )
}
