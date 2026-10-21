-- aum_history: the persisted Dune supply/AUM series (query 7696914), one row per
-- (Ethereum token address, UTC day) with that day's raw end-of-day supply.
--
-- WHY. Until 2026-10-19 the homepage read the FULL Dune result set live on every
-- cache revalidation (4,064 rows × 3 columns = 12,192 datapoints each) and the
-- monthly index backfill read it again. Dune charges its per-cycle datapoint quota
-- on every row read, and on 2026-09-24 the quota ran out: every nightly execution
-- since returned HTTP 402, the homepage AUM chart went dark, and the 2026-10-01
-- monthly reading died before writing September. With the series persisted here,
-- the nightly refresh (scripts/refresh-dune.ts) reads only ~a week of rows, and
-- NOTHING on the request path or in the backfill touches Dune.
--
-- Rows carry the execution they came from. lookupAum (src/lib/dune/aumSeries.ts)
-- derives how far the series may be read from MAX(executed_at) — the day before
-- that execution's UTC date — and throws for any later date, so a month-end can
-- no longer be silently forward-filled from a stale execution.
--
-- Posture mirrors behavior_history / reconciliation_history (RLS DISABLED, full
-- grants) so the nightly Action, which writes with the ANON key, can UPSERT.

CREATE TABLE IF NOT EXISTS public.aum_history (
  -- Lowercase Ethereum token address, exactly as Dune's contract_address column.
  contract_address text        NOT NULL,
  day              date        NOT NULL,
  -- Raw integer supply (token base units) at end of day. numeric so a 27-digit
  -- value is exact; readers select it ::text so it never passes through a float.
  supply_raw       numeric     NOT NULL,
  -- The Dune execution this row was read from, and that execution's
  -- execution_ended_at (what coverage is derived from).
  execution_id     text        NOT NULL,
  executed_at      timestamptz NOT NULL,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_address, day)
);

-- RLS deliberately left DISABLED to match the sibling tables. Do not enable.

GRANT ALL ON TABLE public.aum_history TO anon, authenticated, service_role;
