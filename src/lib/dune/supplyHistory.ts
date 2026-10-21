import { cacheLife, cacheTag } from 'next/cache'
import { ACTIVE_PRODUCTS, getNavUsd } from '@/src/config/products'
import type { ProductSlug } from '@/src/config/products'
import { loadAumHistory } from './aumStore'
import { coverageThroughFromExecution, forwardFill, groupRowsByProduct } from './aumSeries'
import type { SupplyPoint } from './aumSeries'

export type { SupplyPoint } from './aumSeries'

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
  /** When the nightly refresh last wrote the persisted series. */
  fetchedAt: string
  /** The Dune execution the newest persisted rows came from. */
  executionId: string
  /** Always 'PERSISTED' — the site never reads Dune live. Kept for the debug route. */
  queryState: string
  /** Last complete UTC day the persisted execution covers (aumSeries.ts). */
  coverageThrough: string
}

/**
 * Per-product AUM history from the PERSISTED Dune series in Supabase
 * (aum_history — written nightly by scripts/refresh-dune.ts), with forward-filled
 * gaps. Never calls Dune: the live read is what spent the datapoint quota.
 *
 * BENJI is inactive (active: false in products.ts) so it is excluded from
 * ACTIVE_PRODUCTS and any rows with its contract address are simply ignored.
 *
 * Returns null (and logs) when the table is empty or unreadable, which is what
 * the homepage treats as "chart unavailable".
 */
export async function fetchAumHistory(): Promise<AumHistoryResult | null> {
  'use cache'
  cacheTag('dune-data')
  cacheLife('hours')

  let persisted
  try {
    persisted = await loadAumHistory()
  } catch (err) {
    console.error('[aum_history]', err)
    return null
  }
  if (persisted.rows.length === 0 || !persisted.executedAt || !persisted.executionId) {
    console.error('[aum_history] empty — run `npm run refresh-dune -- --full` once')
    return null
  }

  const grouped = groupRowsByProduct(persisted.rows, ACTIVE_PRODUCTS)
  const products: Partial<Record<ProductSlug, ProductAumHistory>> = {}

  for (const [slug, points] of grouped) {
    const product = ACTIVE_PRODUCTS.find((p) => p.slug === slug)!
    const navUsd = getNavUsd(product)
    const navAsOf = product.navAsOf ?? null
    const series = forwardFill(points, product.decimals, navUsd)
    products[slug as ProductSlug] = {
      productSlug: slug,
      decimals: product.decimals,
      navUsd,
      navAsOf,
      latest: series.at(-1) ?? null,
      series,
    }
  }

  return {
    products,
    fetchedAt: persisted.fetchedAt ?? persisted.executedAt,
    executionId: persisted.executionId,
    queryState: 'PERSISTED',
    coverageThrough: coverageThroughFromExecution(persisted.executedAt),
  }
}
