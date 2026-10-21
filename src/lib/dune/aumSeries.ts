/**
 * Pure series maths over the persisted Dune supply/AUM rows (aum_history).
 * Shared by the homepage chart (supplyHistory.ts) and the monthly index backfill
 * (src/lib/index/backfill.ts) so both read ONE representation of the series and
 * ONE rule for how far it is allowed to be read.
 *
 * Coverage. The Dune query emits one row per (token, day) and the series is
 * forward-filled between rows, so the last ROW is not the data's freshness — a
 * token with no supply change in the final days of a month ends its rows early
 * while its supply is genuinely unchanged. Freshness is the EXECUTION: a run
 * that ended on day D has seen every complete UTC day before D. lookupAum
 * therefore forward-fills freely up to `coverageThrough` (the day before the
 * execution's UTC date) and THROWS for any later date. Before this rule the
 * backfill silently carried the last known value into any month-end you asked
 * for — the 2026-10-01 run, had it got past Dune's 402, would have written a
 * September reading from a 2026-09-23 execution without a word.
 */

import type { ActiveProduct } from '@/src/config/products'

export interface AumHistoryRow {
  /** Lowercase Ethereum token address, as Dune reports it. */
  contractAddress: string
  /** YYYY-MM-DD */
  day: string
  /** Raw integer supply as a decimal string (exact; never a float). */
  supplyRaw: string
}

export interface SupplyPoint {
  day: string       // "YYYY-MM-DD"
  supplyRaw: string // raw integer as string
  aum: number       // USD = supply / 10^decimals × NAV
}

/**
 * Convert raw supply to USD AUM. parseFloat handles both plain integer strings
 * and scientific-notation floats (e.g. "9.728e+26") should a row ever carry one.
 */
export function rawToAum(supplyRaw: string, decimals: number, navUsd: number): number {
  return (parseFloat(supplyRaw) / 10 ** decimals) * navUsd
}

/**
 * Fill every calendar day between the first and last data points, carrying the
 * most recent known supply forward into days with no mint/burn activity.
 */
export function forwardFill(
  sorted: Array<{ day: string; supplyRaw: string }>,
  decimals: number,
  navUsd: number
): SupplyPoint[] {
  if (sorted.length === 0) return []

  const byDay = new Map(sorted.map((p) => [p.day, p.supplyRaw]))
  const result: SupplyPoint[] = []

  let cur = new Date(sorted[0].day + 'T00:00:00Z')
  const end = new Date(sorted.at(-1)!.day + 'T00:00:00Z')
  let lastRaw = sorted[0].supplyRaw

  while (cur <= end) {
    const day = cur.toISOString().slice(0, 10)
    const raw = byDay.get(day)
    if (raw !== undefined) lastRaw = raw
    result.push({ day, supplyRaw: lastRaw, aum: rawToAum(lastRaw, decimals, navUsd) })
    cur = new Date(cur.getTime() + 86_400_000)
  }
  return result
}

/**
 * Group persisted rows by product slug (matched on the product's Ethereum
 * contract address), each list sorted ascending by day. Rows for addresses that
 * are not an active product are ignored (BENJI).
 */
export function groupRowsByProduct(
  rows: AumHistoryRow[],
  products: readonly ActiveProduct[]
): Map<string, Array<{ day: string; supplyRaw: string }>> {
  const addrToSlug = new Map(products.map((p) => [p.contractAddress.toLowerCase(), p.slug]))
  const grouped = new Map<string, Array<{ day: string; supplyRaw: string }>>()
  for (const r of rows) {
    const slug = addrToSlug.get(r.contractAddress.toLowerCase())
    if (!slug) continue
    if (!grouped.has(slug)) grouped.set(slug, [])
    grouped.get(slug)!.push({ day: r.day, supplyRaw: r.supplyRaw })
  }
  for (const points of grouped.values()) points.sort((a, b) => a.day.localeCompare(b.day))
  return grouped
}

/**
 * The last COMPLETE UTC day a Dune execution covers: the day before the
 * execution's UTC date. An execution that ended 2026-10-01T06:35Z has seen all of
 * 2026-09-30; one that ended 2026-10-01T00:00Z has too.
 */
export function coverageThroughFromExecution(executedAtIso: string): string {
  const t = Date.parse(executedAtIso)
  if (Number.isNaN(t)) throw new Error(`coverageThroughFromExecution: unparseable timestamp ${executedAtIso}`)
  const d = new Date(t)
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return new Date(midnight - 86_400_000).toISOString().slice(0, 10)
}

/** The day `days` before `day` (YYYY-MM-DD) — the re-read window start for a refresh. */
export function overlapSince(day: string, days: number): string {
  const t = Date.parse(day + 'T00:00:00Z')
  if (Number.isNaN(t)) throw new Error(`overlapSince: unparseable day ${day}`)
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10)
}

export class AumCoverageError extends Error {
  constructor(
    public readonly label: string,
    public readonly requested: string,
    public readonly coverageThrough: string,
    public readonly seriesEnd: string | null
  ) {
    super(
      `${label}: AUM requested for ${requested} but the persisted Dune series only covers through ` +
        `${coverageThrough} (last execution; last row ${seriesEnd ?? 'none'}). Refusing to forward-fill ` +
        `past the data. Run \`npm run refresh-dune\` after a Dune execution that ended on or after ` +
        `${nextDay(requested)}, then re-run.`
    )
    this.name = 'AumCoverageError'
  }
}

function nextDay(day: string): string {
  return new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10)
}

/**
 * AUM at `date` (YYYY-MM-DD) from a forward-filled series.
 *   • date > coverageThrough           → THROWS AumCoverageError (never forward-fills past the data)
 *   • series empty or date < first day → null (product not live yet)
 *   • otherwise                        → the last point at or before `date`; a date after the
 *                                        last row but within coverage is a genuine
 *                                        no-supply-change stretch and returns the last row
 */
export function lookupAum(
  series: SupplyPoint[],
  date: string,
  coverageThrough: string,
  label: string
): number | null {
  const seriesEnd = series.at(-1)?.day ?? null
  if (date > coverageThrough) throw new AumCoverageError(label, date, coverageThrough, seriesEnd)
  if (series.length === 0 || date < series[0].day) return null
  let result: number | null = null
  for (const point of series) {
    if (point.day <= date) result = point.aum
    else break
  }
  return result
}
