-- Persisted per-network backfill window span (days) for the chunked first-backfill.
--
-- The chunked backfill sizes each fetch window adaptively (toward ~40 pages) from the
-- last window's observed density, and shrinks the span on a window failure (429 /
-- timeout). Both signals lived only in a run-local variable, so they were LOST between
-- the 3-hourly slots — every slot reset the span to the 30-day initial. At the
-- sparse→dense history boundary that kept re-opening a window far larger than the
-- per-run page pool (~80), which 429'd mid-window, was discarded by per-window
-- atomicity, and re-derived identically next slot: a deterministic failure loop (USDY
-- Solana froze at 2025-11-13).
--
-- This column persists the span across slots so the learned density AND a
-- shrink-on-failure survive: the next slot resumes at the era-correct (or halved) span
-- instead of the initial. Nullable, no default — a NULL (fresh row, or any row
-- predating this column) means "use the initial span", so existing backfills and the
-- classify.ts read path (which treats a missing value / read error as null) are
-- unaffected. apply_incremental_merge / apply_reanchor_swap do not mention this column,
-- so their cursor upserts leave it untouched (a persisted span survives a checkpoint).

ALTER TABLE fetch_cursor
  ADD COLUMN IF NOT EXISTS backfill_span_days integer;
