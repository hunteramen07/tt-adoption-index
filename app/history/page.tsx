import { connection } from 'next/server'
import Link from 'next/link'
import { fetchIndexHistory } from '@/src/lib/index/history'
import type { IndexHistoryRow } from '@/src/lib/index/history'
import { METHODOLOGY_VERSION } from '@/src/config/index-ranges'
import { CompositeHistoryChart } from '../components/charts/CompositeHistoryChart'

export const metadata = {
  title: 'Index History — RTA Index',
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtMonthYear(isoDate: string): string {
  return new Date(isoDate + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** URL slug for a reading: the YYYY-MM-DD reading date. */
function monthSlug(isoDate: string): string {
  return isoDate
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function HistoryPage() {
  await connection()
  const result = await fetchIndexHistory()
  const rowsAsc: IndexHistoryRow[] = result?.rows ?? []

  // Chart wants ascending; list wants descending (newest first).
  const chartData = rowsAsc.map((r) => ({ day: r.readingDate, composite: r.composite }))
  const rowsDesc = [...rowsAsc].reverse()

  // Month-over-month deltas (computed on ascending order, then mapped).
  const deltaByDate = new Map<string, number | null>()
  for (let i = 0; i < rowsAsc.length; i++) {
    deltaByDate.set(
      rowsAsc[i].readingDate,
      i === 0 ? null : rowsAsc[i].composite - rowsAsc[i - 1].composite
    )
  }

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
        {/* Title */}
        <div className="mb-8">
          <h1 className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-1">
            Index History
          </h1>
          <p className="text-lg font-semibold text-zinc-900">
            RTA Index &mdash; Monthly Readings
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            Every monthly composite reading, newest first. Select a score to see its
            factor breakdown. A reading of 50 means adoption is flat; above 50,
            accelerating; below 50, contracting.
          </p>
        </div>

        {rowsDesc.length > 0 ? (
          <>
            {/* Month list */}
            <div className="overflow-hidden rounded border border-zinc-100">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    <th className="px-4 py-3">Month</th>
                    <th className="px-4 py-3 text-right">Composite</th>
                    <th className="px-4 py-3 text-right">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50">
                  {rowsDesc.map((r, i) => {
                    const delta = deltaByDate.get(r.readingDate) ?? null
                    return (
                      <tr
                        key={r.readingDate}
                        className={`${
                          i % 2 === 0 ? 'bg-white' : 'bg-zinc-50/50'
                        } hover:bg-blue-50/30 transition-colors`}
                      >
                        {/* Month */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="text-zinc-800 font-medium">
                            {fmtMonthYear(r.readingDate)}
                          </span>
                          {r.isPartial && (
                            <span
                              className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 align-middle"
                              title={r.partialReason ?? 'Partial reading'}
                            >
                              Partial
                            </span>
                          )}
                        </td>

                        {/* Composite — clickable through to detail */}
                        <td className="px-4 py-3 text-right">
                          <Link
                            href={`/history/${monthSlug(r.readingDate)}`}
                            className="font-mono tabular-nums text-base font-semibold text-blue-700 hover:text-blue-900 hover:underline"
                          >
                            {r.composite.toFixed(1)}
                          </Link>
                        </td>

                        {/* Change vs prior month */}
                        <td className="px-4 py-3 text-right">
                          {delta !== null ? (
                            <span
                              className={`font-mono tabular-nums text-xs ${
                                delta >= 0 ? 'text-emerald-700' : 'text-red-600'
                              }`}
                            >
                              {delta >= 0 ? '▲ +' : '▼ '}
                              {delta.toFixed(1)}
                            </span>
                          ) : (
                            <span className="text-xs text-zinc-300">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-zinc-400">
              Source: Supabase (index_readings)
              {result?.fetchedAt && <> &middot; Refreshed {fmtTimestamp(result.fetchedAt)}</>}
            </p>

            {/* Composite over time */}
            <div className="mt-12">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-1">
                Composite Over Time
              </h2>
              <p className="text-sm text-zinc-500 mb-4">
                {rowsAsc.length} reading{rowsAsc.length !== 1 ? 's' : ''} &middot;{' '}
                {fmtMonthYear(rowsAsc[0].readingDate)} – {fmtMonthYear(rowsAsc.at(-1)!.readingDate)}
              </p>
              <div className="rounded border border-zinc-100 bg-white p-4">
                <CompositeHistoryChart data={chartData} />
              </div>
            </div>
          </>
        ) : (
          <div className="rounded border border-zinc-100 bg-zinc-50 px-6 py-8 text-center text-sm text-zinc-400">
            No index readings available yet
          </div>
        )}
      </main>

      <footer className="border-t border-zinc-100 mt-16 px-4 sm:px-6 py-6">
        <div className="max-w-7xl mx-auto text-xs text-zinc-400">
          RTA Index v{METHODOLOGY_VERSION} &middot; Ethereum mainnet only &middot; Not financial advice
        </div>
      </footer>
    </div>
  )
}
