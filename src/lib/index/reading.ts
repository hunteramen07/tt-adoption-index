/**
 * Writes RTA Index composite + per-factor sub-scores to the Supabase
 * `index_readings` table.
 *
 * Required table:
 *
 *   CREATE TABLE index_readings (
 *     reading_date        date    PRIMARY KEY,
 *     composite           numeric NOT NULL,
 *     factors             jsonb   NOT NULL,  -- per-factor { raw, score } objects
 *     is_partial          boolean NOT NULL DEFAULT false,
 *     partial_reason      text,
 *     methodology_version text    NOT NULL DEFAULT '1.0'
 *   );
 */

import { getSupabase } from '@/src/lib/supabase/client'
import type { IndexReading } from './types'

export async function writeIndexReading(reading: IndexReading): Promise<void> {
  const supabase = getSupabase()

  const { error } = await supabase
    .from('index_readings')
    .upsert(
      {
        reading_date: reading.readingDate,
        composite: reading.composite,
        factors: reading.factors,
        is_partial: reading.isPartial,
        partial_reason: reading.partialReason,
        methodology_version: reading.methodologyVersion,
      },
      { onConflict: 'reading_date' }
    )

  if (error) throw new Error(`index_readings upsert failed: ${error.message}`)
}
