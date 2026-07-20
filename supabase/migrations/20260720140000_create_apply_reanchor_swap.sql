-- Atomic REPLACE-semantics write for the periodic re-anchor (full-history rebuild).
--
-- Distinct from apply_incremental_merge, which UPSERTS and never deletes rows
-- (exited holders are retained as balance-0). That never-deletes property is a
-- safety INVARIANT of the incremental path — so re-anchor gets its own explicitly
-- named RPC rather than a destructive flag on the merge function, which could fire
-- by accident and silently wipe a network.
--
-- Re-anchor rebuilds a (product, network)'s entire holder_balance_state from epoch
-- and must REPLACE the stored rows wholesale — dropping any stale rows (e.g.
-- case-folded duplicate keys, orphaned phantoms) that a clean rebuild would not
-- reproduce. This function does that swap atomically:
--   DELETE all rows for (product, network)  →  INSERT the candidate set  →
--   set the cursor to the rebuilt position.
-- A PL/pgSQL body runs in one implicit transaction, so the delete + insert +
-- cursor move are all-or-nothing. On any error the whole call rolls back and the
-- prior state + cursor survive; re-running is idempotent.
--
-- IMPORTANT: the caller (classify.ts REANCHOR mode) only invokes this AFTER the
-- supply-reconciliation gate has confirmed the candidate is no worse than stored
-- state. This function performs no gating — it is the unconditional swap.
--
-- p_balances: FULL candidate balance set as a jsonb array of
--   { address, balance, first_receipt }, same shape as apply_incremental_merge —
--   balance a raw-integer STRING (lossless ::numeric), first_receipt ISO-8601 or null.
-- Unlike the merge RPC, first_receipt is taken straight from the candidate (a full
-- rebuild reconstructs the true earliest receipt from complete history — there is
-- no existing row to COALESCE against, since we just deleted them all).
--
-- p_last_tx_timestamp / p_boundary_tx_ids: the cursor computed from the rebuilt
-- transaction set (exactly as a normal full backfill computes it). When null (a
-- genuinely empty rebuild) the cursor row is DELETED so state and cursor stay
-- consistent (empty state ⇒ no cursor ⇒ next run does a full backfill).
--
-- Posture matches the other pipeline tables/functions: callable by anon (the
-- pipeline writes with the ANON key; RLS is disabled on these tables).

DROP FUNCTION IF EXISTS apply_reanchor_swap(text, text, jsonb, timestamptz, text[]);

CREATE OR REPLACE FUNCTION apply_reanchor_swap(
  p_product_slug      text,
  p_network           text,
  p_balances          jsonb,
  p_last_tx_timestamp timestamptz,
  p_boundary_tx_ids   text[]
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- 1. Drop the entire stored state for this (product, network). This is the
  --    difference from the merge RPC: stale/duplicate/phantom rows are removed,
  --    not carried forward.
  DELETE FROM holder_balance_state
  WHERE product_slug = p_product_slug
    AND network = p_network;

  -- 2. Insert the candidate set verbatim (including retained balance-0 exits the
  --    rebuild itself produced). No COALESCE on first_receipt — there is no prior
  --    row after the delete, and the full rebuild already carries the true earliest
  --    receipt.
  INSERT INTO holder_balance_state (product_slug, network, address, balance, first_receipt, updated_at)
  SELECT
    p_product_slug,
    p_network,
    (elem->>'address'),
    (elem->>'balance')::numeric,
    NULLIF(elem->>'first_receipt', '')::timestamptz,
    now()
  FROM jsonb_array_elements(p_balances) AS elem;

  -- 3. Move the cursor to the rebuilt position (or reset it when the rebuild is
  --    empty, keeping state and cursor mutually consistent).
  IF p_last_tx_timestamp IS NOT NULL THEN
    INSERT INTO fetch_cursor (product_slug, network, last_tx_timestamp, boundary_tx_ids, updated_at)
    VALUES (p_product_slug, p_network, p_last_tx_timestamp, COALESCE(p_boundary_tx_ids, '{}'), now())
    ON CONFLICT (product_slug, network)
    DO UPDATE SET
      last_tx_timestamp = EXCLUDED.last_tx_timestamp,
      boundary_tx_ids   = EXCLUDED.boundary_tx_ids,
      updated_at        = now();
  ELSE
    DELETE FROM fetch_cursor
    WHERE product_slug = p_product_slug
      AND network = p_network;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_reanchor_swap(text, text, jsonb, timestamptz, text[])
  TO anon, authenticated, service_role;
