/**
 * Historical monthly backfill for the RTA Index.
 *
 * For each calendar month-end from the earliest available on-chain data
 * through last month, computes:
 *   - Per-product snapshots (from cached transfer histories + Dune AUM series)
 *   - Factor inputs (from cross-product aggregates and 3-month deltas)
 *   - Index readings (composite + per-factor sub-scores)
 *
 * NAV caveat: AUM for all historical months uses the current hardcoded NAV
 * (products.ts). OUSG accrued from ~$100 to ~$115 since Jan 2023, so early
 * OUSG AUM is overstated by ~15%. Historical NAV support is a v1.1 item.
 *
 * Transfer volume caveat: mints and burns are excluded. Only holder-to-holder
 * transfers are counted so that issuance does not inflate the activity signal.
 *
 * After writing all readings this function prints a table of raw factor values
 * for calibration review. DO NOT finalize index-ranges.ts until reviewing it.
 */

import { ACTIVE_PRODUCTS } from '@/src/config/products'
import { diskCacheReadStale } from '@/src/lib/cache/disk'
import { duneGetLatestResults } from '@/src/lib/dune/client'
import { computeBalances } from '@/src/lib/etherscan/balances'
import type { ERC20Transfer } from '@/src/lib/etherscan/types'
import { computeIndexReading } from './compute'
import { writeSnapshots } from './snapshot'
import { writeIndexReading } from './reading'
import type { FactorInputs, ProductSnapshot } from './types'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DUNE_SUPPLY_QUERY_ID = 7696914
const DAYS_90 = 90 * 24 * 3600
const DAYS_30 = 30 * 24 * 3600

// ── AUM history from Dune ─────────────────────────────────────────────────

interface DailySupplyPoint {
  day: string // YYYY-MM-DD
  aum: number // USD
}

interface ProductAumSeries {
  slug: string
  series: DailySupplyPoint[] // sorted ascending by day
}

async function loadAumSeries(): Promise<Map<string, ProductAumSeries>> {
  const data = await duneGetLatestResults(DUNE_SUPPLY_QUERY_ID)
  if (!data?.result) throw new Error('Dune query returned no results')

  const addrToProduct = new Map(
    ACTIVE_PRODUCTS.map((p) => [p.contractAddress.toLowerCase(), p])
  )

  const grouped = new Map<string, Array<{ day: string; supplyRaw: string }>>()
  for (const row of data.result.rows) {
    const product = addrToProduct.get(row.contract_address.toLowerCase())
    if (!product) continue
    const slug = product.slug
    if (!grouped.has(slug)) grouped.set(slug, [])
    grouped.get(slug)!.push({
      day: row.day.slice(0, 10),
      supplyRaw: String(row.supply_raw),
    })
  }

  const result = new Map<string, ProductAumSeries>()
  for (const [slug, points] of grouped) {
    const product = ACTIVE_PRODUCTS.find((p) => p.slug === slug)!
    const navUsd = product.navUsd ?? 1
    points.sort((a, b) => a.day.localeCompare(b.day))
    const series = forwardFill(points, product.decimals, navUsd)
    result.set(slug, { slug, series })
  }
  return result
}

function forwardFill(
  sorted: Array<{ day: string; supplyRaw: string }>,
  decimals: number,
  navUsd: number
): DailySupplyPoint[] {
  if (sorted.length === 0) return []

  const byDay = new Map(sorted.map((p) => [p.day, p.supplyRaw]))
  const result: DailySupplyPoint[] = []

  let cur = new Date(sorted[0].day + 'T00:00:00Z')
  const end = new Date(sorted.at(-1)!.day + 'T00:00:00Z')
  let lastRaw = sorted[0].supplyRaw

  while (cur <= end) {
    const day = cur.toISOString().slice(0, 10)
    const raw = byDay.get(day)
    if (raw !== undefined) lastRaw = raw
    result.push({ day, aum: rawToAum(lastRaw, decimals, navUsd) })
    cur = new Date(cur.getTime() + 86_400_000)
  }
  return result
}

function rawToAum(supplyRaw: string, decimals: number, navUsd: number): number {
  return (parseFloat(supplyRaw) / 10 ** decimals) * navUsd
}

/** Find the AUM at or before a given YYYY-MM-DD date (binary search). */
function lookupAum(series: DailySupplyPoint[], date: string): number | null {
  let result: number | null = null
  for (const point of series) {
    if (point.day <= date) result = point.aum
    else break
  }
  return result
}

// ── Transfer history from disk cache ─────────────────────────────────────

function loadTransfers(contractAddress: string): ERC20Transfer[] {
  const cacheKey = `transfers-${contractAddress.toLowerCase()}`
  const cached = diskCacheReadStale<ERC20Transfer[]>(cacheKey)
  if (!cached || cached.data.length === 0) return []
  return cached.data
}

// ── Per-product metrics at a month-end timestamp ─────────────────────────

interface ProductMetricsAtDate {
  slug: string
  aum: number           // USD
  holderCount: number
  top5Share: number     // fraction 0–1
  dormancyShare: number // fraction 0–1
  velocity: number      // volume30d_USD / aum (0 if aum = 0)
}

function computeProductMetrics(
  slug: string,
  transfers: ERC20Transfer[],
  monthEndTs: number,
  aum: number,
  navUsd: number,
  decimals: number
): ProductMetricsAtDate {
  const upTo = transfers.filter((t) => parseInt(t.timeStamp) <= monthEndTs)

  const balances = computeBalances(upTo)
  const holderCount = balances.size

  // Top-5 concentration
  const sorted = [...balances.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
  const totalSupply = [...balances.values()].reduce((s, v) => s + v, BigInt(0))
  const top5Sum = sorted.slice(0, 5).reduce((s, [, v]) => s + v, BigInt(0))
  const top5Share = totalSupply > BigInt(0) ? Number(top5Sum * BigInt(10000) / totalSupply) / 10000 : 0

  // Dormancy (90-day lookback): share of supply with no outbound transfer in window
  const windowStart90 = monthEndTs - DAYS_90
  const hadOutbound = new Set<string>()
  for (const t of upTo) {
    if (parseInt(t.timeStamp) >= windowStart90 && t.from.toLowerCase() !== ZERO_ADDRESS) {
      hadOutbound.add(t.from.toLowerCase())
    }
  }
  let dormantSupply = BigInt(0)
  for (const [addr, bal] of balances) {
    if (!hadOutbound.has(addr.toLowerCase())) dormantSupply += bal
  }
  const dormancyShare = totalSupply > BigInt(0) ? Number(dormantSupply * BigInt(10000) / totalSupply) / 10000 : 0

  // 30-day transfer volume (holder-to-holder only; excludes mints and burns)
  const windowStart30 = monthEndTs - DAYS_30
  let volumeRaw = BigInt(0)
  for (const t of upTo) {
    const ts = parseInt(t.timeStamp)
    if (ts < windowStart30) continue
    if (t.from.toLowerCase() === ZERO_ADDRESS || t.to.toLowerCase() === ZERO_ADDRESS) continue
    volumeRaw += BigInt(t.value)
  }
  // Divide in two steps to avoid precision loss for large BigInts (18-decimal tokens)
  const divisorExp = Math.max(0, decimals - 6)
  const microTokens = Number(volumeRaw / (BigInt(10) ** BigInt(divisorExp)))
  const transferVolume30dUsd = (microTokens / 10 ** Math.min(decimals, 6)) * navUsd

  const velocity = aum > 0 ? transferVolume30dUsd / aum : 0

  return { slug, aum, holderCount, top5Share, dormancyShare, velocity }
}

// ── Month-end date helpers ────────────────────────────────────────────────

function lastDayOfMonth(year: number, month: number): string {
  // Date(year, month, 0) = last day of (month-1); month is 1-indexed here
  const d = new Date(Date.UTC(year, month, 0))
  return d.toISOString().slice(0, 10)
}

function monthEndDates(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  const start = new Date(startDate + 'T00:00:00Z')
  const end = new Date(endDate + 'T00:00:00Z')

  let year = start.getUTCFullYear()
  let month = start.getUTCMonth() + 1 // 1-indexed

  while (true) {
    const date = lastDayOfMonth(year, month)
    if (date > endDate) break
    const d = new Date(date + 'T00:00:00Z')
    if (d >= start) dates.push(date)
    month++
    if (month > 12) { month = 1; year++ }
    if (new Date(Date.UTC(year, month - 1, 1)) > end) break
  }
  return dates
}

function toUnixTs(date: string): number {
  return Math.floor(new Date(date + 'T23:59:59Z').getTime() / 1000)
}

// ── Main backfill function ────────────────────────────────────────────────

export interface BackfillOptions {
  writeToDb?: boolean   // default true; false = dry-run (print table only)
  verbose?: boolean     // default false; true = log each month
}

export async function runBackfill(options: BackfillOptions = {}): Promise<void> {
  const { writeToDb = true, verbose = false } = options

  console.log('\n=== RTA Index Backfill ===')
  console.log(`NAV caveat: using hardcoded current NAVs for all historical months.`)
  console.log(`OUSG accrued from ~$100→$115 since Jan 2023; early AUM ~15% overstated.\n`)

  // 1. Load AUM series from Dune
  console.log('Loading Dune AUM history…')
  const aumSeries = await loadAumSeries()
  console.log(`  got series for: ${[...aumSeries.keys()].join(', ')}`)

  // 2. Load transfer histories from disk cache
  console.log('Loading transfer histories from disk cache…')
  const transfersBySlug = new Map<string, ERC20Transfer[]>()
  for (const product of ACTIVE_PRODUCTS) {
    const txs = loadTransfers(product.contractAddress)
    transfersBySlug.set(product.slug, txs)
    console.log(`  ${product.slug}: ${txs.length} transfers`)
  }

  // 3. Determine the date range
  // Earliest: first month-end after the earliest data point across all products
  const allDates: string[] = []
  for (const series of aumSeries.values()) {
    if (series.series.length > 0) allDates.push(series.series[0].day)
  }
  for (const [, txs] of transfersBySlug) {
    if (txs.length > 0) {
      const d = new Date(parseInt(txs[0].timeStamp) * 1000).toISOString().slice(0, 10)
      allDates.push(d)
    }
  }
  if (allDates.length === 0) throw new Error('No data found in cache. Run `npm run classify` first.')

  const earliestDate = allDates.reduce((a, b) => (a < b ? a : b))
  // End at the last complete month (one month before today)
  const today = new Date()
  const lastCompleteMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))
  const endDate = lastCompleteMonth.toISOString().slice(0, 10)

  console.log(`\nBackfilling ${earliestDate} → ${endDate}`)
  const dates = monthEndDates(earliestDate, endDate)
  console.log(`${dates.length} month-end readings to compute\n`)

  if (dates.length === 0) {
    console.log('Nothing to backfill.')
    return
  }

  // 4. Compute per-month aggregates
  interface MonthData {
    date: string
    totalAum: number
    totalHolders: number
    avgTop5Share: number   // simple mean across products with data
    avgDormancyShare: number
    velocity: number        // total_volume30d_USD / total_AUM
    liveProducts: number
    productSnapshots: ProductSnapshot[]
  }

  const monthlyData: MonthData[] = []

  for (const date of dates) {
    const ts = toUnixTs(date)
    const snapshots: ProductSnapshot[] = []
    let totalAum = 0
    let totalHolders = 0
    let top5Shares: number[] = []
    let dormancyShares: number[] = []
    let totalVolume30d = 0
    let liveCount = 0

    for (const product of ACTIVE_PRODUCTS) {
      const series = aumSeries.get(product.slug)
      const transfers = transfersBySlug.get(product.slug) ?? []
      const navUsd = product.navUsd ?? 1

      // AUM from Dune (may be null for very early dates before product launched)
      const aum = series ? (lookupAum(series.series, date) ?? 0) : 0

      const metrics = computeProductMetrics(
        product.slug, transfers, ts, aum, navUsd, product.decimals
      )

      if (metrics.aum > 0 || metrics.holderCount > 0) liveCount++

      totalAum += metrics.aum
      totalHolders += metrics.holderCount
      if (metrics.holderCount > 0) {
        top5Shares.push(metrics.top5Share)
        dormancyShares.push(metrics.dormancyShare)
      }
      totalVolume30d += metrics.velocity * metrics.aum // recover volume_USD from velocity

      const transferVolume30dUsd = metrics.velocity * metrics.aum

      snapshots.push({
        snapshotDate: date,
        product: product.slug,
        aum: Math.round(metrics.aum * 100) / 100,
        holderCount: metrics.holderCount,
        top5Share: Math.round(metrics.top5Share * 10000) / 10000,
        dormancyShare: Math.round(metrics.dormancyShare * 10000) / 10000,
        transferVolume30d: Math.round(transferVolume30dUsd * 100) / 100,
      })
    }

    const avgTop5Share = top5Shares.length > 0
      ? top5Shares.reduce((s, v) => s + v, 0) / top5Shares.length
      : 0
    const avgDormancyShare = dormancyShares.length > 0
      ? dormancyShares.reduce((s, v) => s + v, 0) / dormancyShares.length
      : 0
    const velocity = totalAum > 0 ? totalVolume30d / totalAum : 0

    monthlyData.push({
      date,
      totalAum,
      totalHolders,
      avgTop5Share,
      avgDormancyShare,
      velocity,
      liveProducts: liveCount,
      productSnapshots: snapshots,
    })

    if (verbose) {
      console.log(`${date}  AUM=$${(totalAum / 1e6).toFixed(1)}M  H=${totalHolders}  live=${liveCount}`)
    }
  }

  // 5. Compute factor inputs for each month, write snapshots and readings
  // We need month-index lookback: index i → 3m prior = index (i-3)
  // Transfer activity ratio: velocity[i] / mean(velocity[i-1..i-3]) — requires i >= 3

  // Print table header — each factor shown as "raw(score)"
  const header = [
    'Date      ',
    'Comp',
    ' ',
    'AUM_3m(scr)     ',
    'H_3m(scr)       ',
    'Conc_Δ(scr)   ',
    'Dorm_Δ(scr)   ',
    'TxRatio(scr)',
    'Brd(scr)',
  ].join('  ')
  const divider = '-'.repeat(header.length)

  const tableRows: string[] = [divider, header, divider]

  for (let i = 0; i < monthlyData.length; i++) {
    const current = monthlyData[i]
    const prior3 = i >= 3 ? monthlyData[i - 3] : null

    // Velocity for 3-month average: use months i-1, i-2, i-3
    let transferActivityRatio: number | undefined
    if (i >= 3) {
      const priorVelocities = [
        monthlyData[i - 1].velocity,
        monthlyData[i - 2].velocity,
        monthlyData[i - 3].velocity,
      ]
      const avgVelocity = priorVelocities.reduce((s, v) => s + v, 0) / 3
      transferActivityRatio = avgVelocity > 0 ? current.velocity / avgVelocity : undefined
    }

    const inputs: FactorInputs = {
      readingDate: current.date,

      aumGrowth3m: prior3 && prior3.totalAum > 0
        ? (current.totalAum - prior3.totalAum) / prior3.totalAum
        : undefined,

      holderGrowth3m: prior3 && prior3.totalHolders > 0
        ? (current.totalHolders - prior3.totalHolders) / prior3.totalHolders
        : undefined,

      concentrationDelta3m: prior3
        ? current.avgTop5Share - prior3.avgTop5Share
        : undefined,

      dormancyDelta3m: prior3
        ? current.avgDormancyShare - prior3.avgDormancyShare
        : undefined,

      transferActivityRatio,

      // In v1 Ethereum is the only chain; breadth = live_products + 1
      breadth: current.liveProducts + 1,
    }

    let reading
    try {
      reading = computeIndexReading(inputs)
    } catch {
      // All factors missing (very early months with no data at all)
      if (verbose) console.warn(`${current.date}: skipped — no factors available`)
      continue
    }

    // Write to Supabase
    if (writeToDb) {
      await writeSnapshots(current.productSnapshots)
      await writeIndexReading(reading)
    }

    // Format raw value + score as "raw(score)" pair
    const pair = (
      raw: number | undefined,
      score: number | undefined,
      rawFn: (v: number) => string,
      w: number
    ): string => {
      if (raw === undefined || score === undefined) return '—'.padEnd(w)
      return `${rawFn(raw)}(${score.toFixed(1)})`.padEnd(w)
    }

    const pct1 = (v: number) => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'
    const dec2 = (v: number) => v.toFixed(2)
    const int0 = (v: number) => v.toFixed(0)

    const f = reading.factors
    tableRows.push([
      current.date,
      reading.composite.toFixed(1).padStart(5),
      reading.isPartial ? '*' : ' ',
      pair(f.aumGrowth3m?.raw,          f.aumGrowth3m?.score,          pct1, 16),
      pair(f.holderGrowth3m?.raw,        f.holderGrowth3m?.score,        pct1, 16),
      pair(f.concentrationDelta3m?.raw,  f.concentrationDelta3m?.score,  pct1, 14),
      pair(f.dormancyDelta3m?.raw,       f.dormancyDelta3m?.score,       pct1, 14),
      pair(f.transferActivityRatio?.raw, f.transferActivityRatio?.score, dec2, 12),
      pair(f.breadth?.raw,               f.breadth?.score,               int0,  9),
    ].join('  '))
  }

  tableRows.push(divider)
  tableRows.push('* = partial reading (weights renormalized over available factors)')
  tableRows.push('Columns: date  comp *  AUM_3m(scr)       H_3m(scr)         Conc_Δ(scr)     Dorm_Δ(scr)     TxRatio(scr)   Brd(scr)')

  console.log('\n=== CALIBRATED FACTOR VALUES AND SCORES ===\n')
  console.log(tableRows.join('\n'))

  if (writeToDb) {
    console.log(`✓ Wrote ${monthlyData.length} months of snapshots and index readings to Supabase.`)
  } else {
    console.log('(dry-run: no database writes)')
  }
}
