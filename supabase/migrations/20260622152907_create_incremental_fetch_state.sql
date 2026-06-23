-- Incremental-fetch state for the multi-chain pipeline.
--
-- fetch_cursor: per (product_slug, network) high-water mark, so a run can resume
-- from the last processed transaction instead of re-pulling full history. The
-- resume key is the transaction TIMESTAMP (rwa.xyz ids are composite,
-- non-numeric, and not time-ordered, so they cannot order a cursor);
-- boundary_tx_ids holds every composite id at last_tx_timestamp, which the
-- inclusive gte(date) re-fetch returns again and the incremental layer dedups by
-- id equality. See src/lib/rwa/incremental.ts.
-- holder_balance_state: persisted per-(product, network, address) balances so the
-- replay can be applied incrementally rather than from genesis each run.
--
-- Posture matches the other pipeline tables (e.g. holder_aggregate_stats,
-- behavior_history): RLS left DISABLED (the pipeline writes with the ANON key),
-- with full table privileges granted to anon/authenticated/service_role. These
-- reproduce the Supabase schema-default grants explicitly so the anon write path
-- cannot silently regress. Natural composite PKs, matching the surrogate-id-free
-- convention of the existing tables.

CREATE TABLE fetch_cursor (
  product_slug      text NOT NULL,
  network           text NOT NULL,
  last_tx_timestamp timestamptz,
  boundary_tx_ids   text[] NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_slug, network)
);

CREATE TABLE holder_balance_state (
  product_slug   text    NOT NULL,
  network        text    NOT NULL,
  address        text    NOT NULL,
  balance        numeric NOT NULL,
  first_receipt  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_slug, network, address)
);

-- RLS deliberately left DISABLED to match the other pipeline tables. Do not enable.

GRANT ALL ON TABLE fetch_cursor TO anon, authenticated, service_role;
GRANT ALL ON TABLE holder_balance_state TO anon, authenticated, service_role;
