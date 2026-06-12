import { cacheLife, cacheTag } from 'next/cache'
import { getSupabase } from '@/src/lib/supabase/client'
import type { IndexReading } from './types'

export type IndexHistoryRow = Pick<
  IndexReading,
  'readingDate' | 'composite' | 'factors' | 'isPartial' | 'partialReason' | 'methodologyVersion'
>

export interface IndexHistoryResult {
  rows: IndexHistoryRow[]
  fetchedAt: string
}

export async function fetchIndexHistory(): Promise<IndexHistoryResult | null> {
  'use cache'
  cacheTag('index-data')
  cacheLife('hours')

  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('index_readings')
      .select('reading_date, composite, factors, is_partial, partial_reason, methodology_version')
      .order('reading_date', { ascending: true })

    if (error) throw error
    if (!data) return { rows: [], fetchedAt: new Date().toISOString() }

    const rows: IndexHistoryRow[] = data.map((r) => ({
      readingDate: r.reading_date as string,
      composite: Number(r.composite),
      factors: r.factors as IndexReading['factors'],
      isPartial: r.is_partial as boolean,
      partialReason: r.partial_reason as string | null,
      methodologyVersion: r.methodology_version as string,
    }))

    return { rows, fetchedAt: new Date().toISOString() }
  } catch {
    return null
  }
}
