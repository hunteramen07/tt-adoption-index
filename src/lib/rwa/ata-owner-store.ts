/**
 * Persisted Solana ATA→owner map (`solana_ata_owner`), backing the resolution
 * ladder's rung 4 in solana-resolve.ts.
 *
 * WHY PERSIST. A closed ATA has no on-chain account, so its owner can only come from
 * feed pairing. Pairing is cheap when the twin sits in the same fetch window and costs
 * a bounded cross-window escalation (2 rwa.xyz requests) when it does not. The backfill
 * runs in 3-hourly slots against a 120 req/hr ceiling, so paying that escalation again
 * every slot for the same handful of addresses is pure waste. This table makes it
 * once-ever.
 *
 * WHAT IS STORED. Only ATAs that were absent from chain at resolution time. A live ATA
 * is re-derived from `getAccountInfo` on every run, so caching one buys nothing and a
 * stale row could only mislead. That restriction also disposes of the close-and-reopen-
 * under-a-different-owner hazard: a row is only ever consulted while the account is
 * missing from chain, and for that period the historical owner IS the correct answer.
 *
 * NOT keyed by fund or network. An ATA address is unique across mints on Solana, so the
 * mapping is a global chain fact — BUIDL, USTB, USYC and USDY all share the table.
 *
 * FAILURE POSTURE. Both methods throw on a Supabase error; solana-resolve wraps every
 * call and downgrades a failure to a warning. That is deliberate — the table may not
 * exist yet (the migration is applied by hand), and escalation still resolves the
 * address without it. A missing store must never break a run that would otherwise work.
 */

import { getSupabase } from '@/src/lib/supabase/client'

/** Chunk size for the `in` filters — keeps the PostgREST query string well bounded. */
const IN_CHUNK = 200
/** Chunk size for upserts, matching the classify pipeline's UPSERT_BATCH convention. */
const UPSERT_CHUNK = 500

export interface AtaOwnerRow {
  ata: string
  owner: string
}

/**
 * Supabase-backed store. Construction is free — `getSupabase()` is a lazy singleton,
 * so building one costs nothing on the EVM paths that never call it.
 */
export function makeSupabaseAtaOwnerStore() {
  return {
    async load(atas: string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>()
      if (atas.length === 0) return out
      const supabase = getSupabase()
      for (let i = 0; i < atas.length; i += IN_CHUNK) {
        const chunk = atas.slice(i, i + IN_CHUNK)
        const { data, error } = await supabase
          .from('solana_ata_owner')
          .select('ata, owner')
          .in('ata', chunk)
        if (error) throw new Error(`solana_ata_owner read failed: ${error.message}`)
        for (const row of (data ?? []) as AtaOwnerRow[]) out.set(row.ata, row.owner)
      }
      return out
    },

    async save(entries: ReadonlyArray<AtaOwnerRow>): Promise<void> {
      if (entries.length === 0) return
      const supabase = getSupabase()
      // `source` records how the mapping was derived, for auditability; `learned_at`
      // defaults in the DB. Upsert on the `ata` primary key so a re-derivation of the
      // same mapping is a no-op rather than a conflict.
      const rows = entries.map((e) => ({ ata: e.ata, owner: e.owner, source: 'pairing' }))
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const { error } = await supabase
          .from('solana_ata_owner')
          .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'ata' })
        if (error) throw new Error(`solana_ata_owner write failed: ${error.message}`)
      }
    },
  }
}
