import { cacheLife, cacheTag } from 'next/cache'
import { ACTIVE_PRODUCTS } from '@/src/config/products'
import type { ProductSlug } from '@/src/config/products'
import { duneGetLatestResults } from './client'

const SUPPLY_QUERY_ID = 7696914

export interface SupplyPoint {
  day: string       // "YYYY-MM-DD"
  supplyRaw: string // raw integer as string
  aum: number       // USD at ~$1 NAV per token unit
}

export interface ProductAumHistory {
  productSlug: string
  decimals: number
  /** NAV per token in USD used for this product's AUM calculation */
  navUsd: number
  /** ISO date when navUsd was last verified; null for stable-$1 products */
  navAsOf: string | null
  /** Last point in the forward-filled series */
  latest: SupplyPoint | null
  /** Complete daily series from first activity to last, with gaps forward-filled */
  series: SupplyPoint[]
}

export interface AumHistoryResult {
  products: Partial<Record<ProductSlug, ProductAumHistory>>
  fetchedAt: string
  executionId: string
  queryState: string
}

/**
 * Fetches the latest saved Dune results for query 7696914 and returns
 * per-product AUM history with forward-filled gaps.
 *
 * BENJI is inactive (active: false in products.ts) so it is excluded from
 * ACTIVE_PRODUCTS and any rows with its contract address are simply ignored.
 */
export async function fetchAumHistory(): Promise<AumHistoryResult | null> {
  'use cache'
  cacheTag('dune-data')
  cacheLife('hours')

  const data = await duneGetLatestResults(SUPPLY_QUERY_ID)
  if (!data?.result) return null

  // Lowercase contract address → product (active products only)
  const addrToProduct = new Map(
    ACTIVE_PRODUCTS.map((p) => [p.contractAddress.toLowerCase(), p])
  )

  // Group raw rows by slug, normalising supply_raw to string
  const grouped = new Map<ProductSlug, Array<{ day: string; supplyRaw: string }>>()
  for (const row of data.result.rows) {
    const product = addrToProduct.get(row.contract_address.toLowerCase())
    if (!product) continue
    const slug = product.slug
    if (!grouped.has(slug)) grouped.set(slug, [])
    grouped.get(slug)!.push({
      day: row.day.slice(0, 10), // "YYYY-MM-DD"
      supplyRaw: String(row.supply_raw),
    })
  }

  const fetchedAt = new Date().toISOString()
  const products: Partial<Record<ProductSlug, ProductAumHistory>> = {}

  for (const [slug, points] of grouped) {
    const product = ACTIVE_PRODUCTS.find((p) => p.slug === slug)!
    const navUsd = product.navUsd ?? 1
    const navAsOf = product.navAsOf ?? null
    points.sort((a, b) => a.day.localeCompare(b.day))
    const series = forwardFill(points, product.decimals, navUsd)
    products[slug] = {
      productSlug: slug,
      decimals: product.decimals,
      navUsd,
      navAsOf,
      latest: series.at(-1) ?? null,
      series,
    }
  }

  return { products, fetchedAt, executionId: data.execution_id, queryState: data.state }
}

/**
 * Convert raw supply to USD AUM.
 * navUsd is the per-token NAV in USD (1.0 for stable-$1 products, higher for
 * accruing-NAV products like OUSG/USDY/USYC — see Product.navUsd in products.ts).
 * parseFloat handles both plain integer strings and Dune's scientific-notation
 * floats (e.g. "9.728e+26") until the Dune query is fixed to output VARCHAR.
 */
function rawToAum(supplyRaw: string, decimals: number, navUsd: number): number {
  return (parseFloat(supplyRaw) / 10 ** decimals) * navUsd
}

/**
 * Fill every calendar day between the first and last data points, carrying
 * the most recent known supply forward into days with no mint/burn activity.
 */
function forwardFill(
  sorted: Array<{ day: string; supplyRaw: string }>,
  decimals: number,
  navUsd: number,
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
