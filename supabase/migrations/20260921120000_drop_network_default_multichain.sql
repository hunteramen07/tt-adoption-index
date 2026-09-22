-- Drop the temporary DEFAULT 'ethereum' on the `network` column of every table that
-- received it in 20260617153817_add_network_dimension_multichain.sql.
--
-- WHY NOW. That migration called the default "intentional, temporary technical debt"
-- to be removed "once classify.ts explicitly sets `network` on every write (so a
-- forgetting write fails loudly instead of silently mislabeling non-Ethereum data as
-- 'ethereum')". Audit 2026-09-21: every automated write names its network —
--   • scripts/classify.ts upsertClassifications / upsertAggregateStats /
--     insertBehaviorHistory take `network` as a required parameter; the multi-chain
--     write tails (src/lib/rwa/multichain-write.ts) pass net.networkSlug, the
--     Etherscan path passes the literal 'ethereum';
--   • the two SQL functions (apply_incremental_merge, apply_reanchor_swap) touch only
--     holder_balance_state and fetch_cursor;
--   • the one writer that relied on the default, scripts/seed-aggregate-stats.ts,
--     was a stale one-shot (already broken by a pre-network ON CONFLICT) and is
--     deleted in the same change; the snapshots writer (src/lib/index/snapshot.ts)
--     now sets network explicitly and upserts on the three-column key.
-- The columns stay NOT NULL and remain part of each primary key, so a write that
-- omits `network` now fails with a not-null violation instead of being mislabeled.
--
-- Idempotent: DROP DEFAULT on a column with no default is a no-op.

ALTER TABLE public.holder_classifications ALTER COLUMN network DROP DEFAULT;
ALTER TABLE public.holder_aggregate_stats ALTER COLUMN network DROP DEFAULT;
ALTER TABLE public.behavior_history       ALTER COLUMN network DROP DEFAULT;
ALTER TABLE public.snapshots              ALTER COLUMN network DROP DEFAULT;
