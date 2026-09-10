-- solana_ata_owner: persisted Solana ATA → owner-wallet map for the B3 resolver.
--
-- WHY. rwa.xyz's Solana dual feed reports the same transfer twice — once keyed by the
-- associated token account (dash ids) and once by the owner wallet (underscore ids).
-- Everything downstream must key on owners, so each ATA is resolved before merge.
-- getAccountInfo answers that for a LIVE account, but ~21-34% of the dash addresses in
-- any dash-era window belong to ATAs that have since been CLOSED (probe 2026-09-10),
-- and a closed account has no owner field to read. Those are recovered instead by
-- pairing the dash record against its underscore twin, which names the same participant
-- as an owner wallet.
--
-- Pairing is free when the twin sits in the same fetch window and costs a bounded
-- cross-window escalation (2 rwa.xyz requests) when it does not. The chunked backfill
-- runs in 3-hourly slots against a 120 req/hr ceiling, so re-paying that escalation
-- every slot for the same handful of addresses is pure waste. This table makes it
-- once-ever. See _local/solana-ata-resolution-design.md §A4/§A5.
--
-- WHAT IS STORED. ONLY ATAs that were absent from chain at resolution time. A live ATA
-- is re-derived from getAccountInfo on every run, so caching one buys nothing and a
-- stale row could only mislead. That restriction also disposes of the
-- close-and-reopen-under-a-different-owner hazard: a row is only ever consulted while
-- the account is missing from chain, and for that period the historical owner IS the
-- correct answer.
--
-- NOT keyed by fund or network. An ATA address is unique across mints on Solana, so
-- this is a global chain fact — BUIDL, USTB, USYC and USDY all share the table.
--
-- Posture mirrors behavior_history / holder_aggregate_stats EXACTLY:
--   * RLS is DISABLED (not enabled here) and there are no policies, so the nightly
--     Action — which writes with the ANON key — can INSERT/UPSERT.
--   * Full table privileges granted to anon/authenticated/service_role, reproducing
--     the Supabase schema-default grants the sibling tables already carry; granted
--     explicitly so this migration is self-contained and the anon write path cannot
--     silently regress.
-- PK is the ATA itself — the natural key, and what the resolver upserts on.

CREATE TABLE IF NOT EXISTS public.solana_ata_owner (
  ata        text        NOT NULL PRIMARY KEY,
  owner      text        NOT NULL,
  -- How the mapping was derived, for auditability. 'pairing' today; kept as free text
  -- rather than an enum so a future derivation method needs no migration.
  source     text        NOT NULL DEFAULT 'pairing',
  learned_at timestamptz NOT NULL DEFAULT now()
);

-- RLS deliberately left DISABLED to match behavior_history. Do not enable.

GRANT ALL ON TABLE public.solana_ata_owner TO anon, authenticated, service_role;
