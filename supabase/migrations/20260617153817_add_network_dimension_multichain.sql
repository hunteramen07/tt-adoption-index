-- RECOVERED 2026-07-23 from the live DB, byte-verified against the original.
--
-- This migration was applied OUT-OF-BAND via MCP on 2026-06-17 and was never
-- committed to git — no file ever existed in supabase/migrations/ for version
-- 20260617153817 (checked: git log --all across full history, no add and no
-- delete). It is the reverse-drift item flagged in _local/migration-history-repair.sql.
--
-- SOURCE: supabase_migrations.schema_migrations.statements for this version — the
-- exact SQL string MCP recorded when it was applied. The body below is
-- BYTE-IDENTICAL to that recording (md5 905ad0e13c7f975d4f7d4edc398389bc, 1999
-- bytes), so it faithfully reproduces what was originally run — NOT a lossy
-- schema-introspection reconstruction. Committing it closes the git↔DB gap; the
-- history table already has this version, so nothing needs to be re-applied.
--
-- (The `network` DEFAULT 'ethereum' below is the temporary bridging debt described
--  in-body — tracked for removal by the multi-chain rewrite, not by this recovery.)

-- Multi-chain support: add `network` dimension to behavioral/snapshot tables.
-- Existing rows are all Ethereum data, so they backfill to 'ethereum' via the default.
-- The DEFAULT is intentional, temporary technical debt: it bridges the current
-- Ethereum-only pipeline so it keeps working without code changes. It MUST be
-- dropped as the final step of the multi-chain pipeline rewrite, once classify.ts
-- explicitly sets `network` on every write (so a forgetting write fails loudly
-- instead of silently mislabeling non-Ethereum data as 'ethereum').

-- 1. holder_classifications: PK (product_slug, address) -> (product_slug, network, address)
ALTER TABLE holder_classifications
  ADD COLUMN network text NOT NULL DEFAULT 'ethereum';
ALTER TABLE holder_classifications
  DROP CONSTRAINT holder_classifications_pkey;
ALTER TABLE holder_classifications
  ADD CONSTRAINT holder_classifications_pkey PRIMARY KEY (product_slug, network, address);

-- 2. holder_aggregate_stats: PK (product_slug) -> (product_slug, network)
ALTER TABLE holder_aggregate_stats
  ADD COLUMN network text NOT NULL DEFAULT 'ethereum';
ALTER TABLE holder_aggregate_stats
  DROP CONSTRAINT holder_aggregate_stats_pkey;
ALTER TABLE holder_aggregate_stats
  ADD CONSTRAINT holder_aggregate_stats_pkey PRIMARY KEY (product_slug, network);

-- 3. behavior_history: PK (product_slug, recorded_at) -> (product_slug, network, recorded_at)
ALTER TABLE behavior_history
  ADD COLUMN network text NOT NULL DEFAULT 'ethereum';
ALTER TABLE behavior_history
  DROP CONSTRAINT behavior_history_pkey;
ALTER TABLE behavior_history
  ADD CONSTRAINT behavior_history_pkey PRIMARY KEY (product_slug, network, recorded_at);

-- 4. snapshots: PK (snapshot_date, product) -> (snapshot_date, product, network)
ALTER TABLE snapshots
  ADD COLUMN network text NOT NULL DEFAULT 'ethereum';
ALTER TABLE snapshots
  DROP CONSTRAINT snapshots_pkey;
ALTER TABLE snapshots
  ADD CONSTRAINT snapshots_pkey PRIMARY KEY (snapshot_date, product, network);
