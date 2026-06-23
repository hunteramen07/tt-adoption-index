-- Atomic write-back for the incremental fetch-merge layer.
--
-- The incremental pipeline must keep holder_balance_state and fetch_cursor
-- mutually consistent: if a run crashes mid-write, the balances and the cursor
-- must either BOTH advance or BOTH stay put. Otherwise a partial write
-- (balances advanced, cursor not) would, on the next run, re-pull from the old
-- cursor and re-merge the same transactions onto already-advanced balances —
-- double-counting, because the additive merge is not idempotent.
--
-- A PL/pgSQL function body executes inside one implicit transaction, so the
-- balance upserts and the cursor update here are all-or-nothing. On any error
-- the whole call rolls back, leaving the cursor pointing at the last fully
-- written position; the next run re-pulls from there (gte the cursor timestamp)
-- and the boundary dedup (drop ids in boundary_tx_ids) absorbs the overlap.
--
-- Posture matches the other pipeline tables: callable by anon/authenticated/
-- service_role (the pipeline writes with the ANON key; RLS is disabled on these
-- tables). SECURITY INVOKER (default) — the anon role already holds the table
-- privileges granted in 20260622152907_create_incremental_fetch_state.sql.
--
-- p_balances is the FULL merged balance set for (product, network) as a jsonb
-- array of { address, balance, first_receipt }, where:
--   • balance is the raw integer token amount as a STRING (lossless ::numeric).
--   • first_receipt is an ISO-8601 string or null.
-- Exited holders are NOT deleted: they are written as balance-0 rows with their
-- original first_receipt preserved, so a later re-entry keeps its true
-- first-ever-receipt and netNewWallets90d stays identical to a full replay.

-- Replaces the original (…, p_last_tx_id text, p_last_tx_timestamp timestamptz)
-- signature: the cursor now resumes by timestamp and dedups by an id SET, so the
-- old numeric-id-shaped argument is gone. DROP first because CREATE OR REPLACE
-- cannot change a function's argument list.
DROP FUNCTION IF EXISTS apply_incremental_merge(text, text, jsonb, text, timestamptz);

CREATE OR REPLACE FUNCTION apply_incremental_merge(
  p_product_slug      text,
  p_network           text,
  p_balances          jsonb,
  p_last_tx_timestamp timestamptz,
  p_boundary_tx_ids   text[]
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Upsert every merged balance row (including retained balance-0 exits).
  -- first_receipt uses COALESCE(existing, incoming) so an existing first_receipt
  -- is never overwritten — a defense-in-depth mirror of the merge layer, which
  -- already preserves the earliest receipt.
  INSERT INTO holder_balance_state (product_slug, network, address, balance, first_receipt, updated_at)
  SELECT
    p_product_slug,
    p_network,
    (elem->>'address'),
    (elem->>'balance')::numeric,
    NULLIF(elem->>'first_receipt', '')::timestamptz,
    now()
  FROM jsonb_array_elements(p_balances) AS elem
  ON CONFLICT (product_slug, network, address)
  DO UPDATE SET
    balance       = EXCLUDED.balance,
    first_receipt = COALESCE(holder_balance_state.first_receipt, EXCLUDED.first_receipt),
    updated_at    = now();

  -- Advance the cursor only when there was new data (null timestamp ⇒ leave it).
  IF p_last_tx_timestamp IS NOT NULL THEN
    INSERT INTO fetch_cursor (product_slug, network, last_tx_timestamp, boundary_tx_ids, updated_at)
    VALUES (p_product_slug, p_network, p_last_tx_timestamp, COALESCE(p_boundary_tx_ids, '{}'), now())
    ON CONFLICT (product_slug, network)
    DO UPDATE SET
      last_tx_timestamp = EXCLUDED.last_tx_timestamp,
      boundary_tx_ids   = EXCLUDED.boundary_tx_ids,
      updated_at        = now();
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_incremental_merge(text, text, jsonb, timestamptz, text[])
  TO anon, authenticated, service_role;
