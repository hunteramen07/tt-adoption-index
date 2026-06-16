-- behavior_history: append-only nightly log of holder-behavior metrics.
--
-- holder_aggregate_stats holds only CURRENT state (the nightly classify run
-- upserts over it on product_slug), so trends are lost. This table accumulates
-- one row per fund per run so behavior can be charted over time.
--
-- Posture mirrors holder_aggregate_stats EXACTLY (verified against the live DB):
--   * RLS is DISABLED (not enabled here) and there are no policies, so the
--     nightly Action — which writes with the ANON key — can INSERT.
--   * Full table privileges granted to anon/authenticated/service_role. These
--     reproduce the Supabase schema-default grants that holder_aggregate_stats
--     already carries; granted explicitly so this migration is self-contained
--     and the anon write path cannot silently regress.
-- PK is the natural (product_slug, recorded_at) composite, matching the
-- surrogate-id-free convention of snapshots / holder_classifications.

CREATE TABLE public.behavior_history (
  product_slug          text        NOT NULL,
  dormancy_share_pct    numeric     NOT NULL,
  holder_count          integer     NOT NULL,
  behavior_accumulating integer     NOT NULL,
  behavior_distributing integer     NOT NULL,
  behavior_dormant      integer     NOT NULL,
  behavior_active       integer     NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_slug, recorded_at)
);

-- RLS deliberately left DISABLED to match holder_aggregate_stats. Do not enable.

GRANT ALL ON TABLE public.behavior_history TO anon, authenticated, service_role;
