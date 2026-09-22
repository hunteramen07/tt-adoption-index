/**
 * Identity of one rwa.xyz transfer record for page-boundary deduplication.
 *
 * WHY NOT THE ID. The feed is paged on `sort: {field: 'id'}` and on Solana the dash-
 * feed id is NOT unique — two distinct transfers can share `2-<hash>-1` (design doc
 * §A6). Rows with equal sort keys may be re-ordered across a page boundary, which
 * DUPLICATES one record and SKIPS another. Deduplicating by id alone would drop the
 * legitimately distinct twin; deduplicating by the full record identity drops only a
 * genuine repeat. Paired with the exact pre-flight count (backfill-span.ts), the two
 * effects are separable: a boundary reorder yields one duplicate and one skip, the
 * count is unchanged, the duplicate is removed here, and the shortfall then shows.
 */

import type { RwaTransfer } from '@/src/lib/rwa/transfers'

/** id + both counterparties + value: two records equal on all four are one record. */
export const transferRecordKey = (t: Pick<RwaTransfer, 'id' | 'from' | 'to' | 'value'>): string =>
  `${t.id}|${t.from}|${t.to}|${t.value}`

/**
 * Append `incoming` to `out`, skipping records already seen. Returns how many were
 * skipped. `seen` persists across pages so the check spans boundaries.
 */
export function appendDistinct(out: RwaTransfer[], incoming: readonly RwaTransfer[], seen: Set<string>): number {
  let dropped = 0
  for (const t of incoming) {
    const k = transferRecordKey(t)
    if (seen.has(k)) {
      dropped++
      continue
    }
    seen.add(k)
    out.push(t)
  }
  return dropped
}
