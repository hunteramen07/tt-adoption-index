-- Partial-state guard for the resumable/chunked first-backfill.
--
-- A chunked backfill builds holder_balance_state across many runs (a network too
-- big to pull in one shot — USDY Solana is ~1.18M txns / ~1,186 pages, >10h of
-- request budget at the 120/hr limit). Until it reaches the present, stored state
-- is INCOMPLETE, so anything derived from it (holder_count, dormancy, behavior
-- mix, the supply tripwire) would be wrong. This flag marks a (product, network)
-- whose state is mid-build so the pipeline never derives/writes metrics from it and
-- the read layer never surfaces a partial number.
--
-- Default TRUE: every EXISTING fetch_cursor row was fully backfilled by the old
-- all-at-once path, so it is complete. A chunked backfill sets it FALSE explicitly
-- at kickoff (via an upsert in classify.ts) and back to TRUE when it catches up to
-- the present, at which point the ordinary nightly incremental takes over.
--
-- NOT NULL + DEFAULT TRUE means apply_incremental_merge / apply_reanchor_swap need
-- no change: their fetch_cursor upserts don't mention this column, so on INSERT it
-- takes the default (TRUE = complete, correct for the small networks those paths
-- handle) and on UPDATE it is left untouched (preserving a backfill's FALSE).

ALTER TABLE fetch_cursor
  ADD COLUMN backfill_complete boolean NOT NULL DEFAULT true;
