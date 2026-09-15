-- reconciliation_history: append-only log of the supply-reconciliation tripwire.
--
-- WHY. The tripwire compares Σ positive holder balances (the state every derived
-- metric is computed from) against ON-CHAIN supply — getTokenSupply on Solana,
-- totalSupply() on EVM — and until now only console.logged the result. A passing
-- check wrote nothing and a failing one scrolled off a CI log, so a network that
-- drifted for a week (buidl:polygon) left no trail to notice or chart. This table
-- records EVERY evaluation, skips included, one row per (fund, network) per run.
--
-- The reference is chain, NOT /v4/assets: both /v4/transactions (what state is
-- replayed from) and /v4/assets are served from rwa.xyz's own ledger, so a
-- state-vs-assets check is tautological — it passed while buidl:solana sat 4.66%
-- below chain and ustb:solana 13.69% above (probe 2026-09-10). The assets-vs-chain
-- delta is still recorded (assets_delta_pct) as an informational, zero-threshold
-- measure of rwa.xyz's own indexing gap.
--
-- Posture mirrors behavior_history EXACTLY (append-only, natural composite PK,
-- RLS DISABLED, full grants):
--   * RLS is DISABLED (not enabled here) and there are no policies, so the nightly
--     Action — which writes with the ANON key — can INSERT.
--   * Full table privileges granted to anon/authenticated/service_role, reproducing
--     the Supabase schema-default grants the sibling tables already carry; granted
--     explicitly so this migration is self-contained and the anon write path cannot
--     silently regress.

CREATE TABLE IF NOT EXISTS public.reconciliation_history (
  product_slug         text        NOT NULL,
  network              text        NOT NULL,
  -- 'classify' = nightly incremental run; 'reanchor' = post-swap check after a
  -- gated full-history rebuild.
  context              text        NOT NULL DEFAULT 'classify',
  -- pass | warn | skipped_no_reference | skipped_reference_failed |
  -- skipped_degenerate | skipped_dust. Free text rather than an enum so a new
  -- outcome needs no migration.
  outcome              text        NOT NULL,
  -- Which chain read produced the reference ('solana:getTokenSupply',
  -- 'evm:totalSupply'); NULL on a skip with no reference.
  reference            text,
  -- Σ positive holder balances, whole tokens (decimal-adjusted).
  state_tokens         numeric     NOT NULL,
  holder_count         integer     NOT NULL,
  -- Wallets with a negative balance in state — impossible on-chain, reported
  -- unconditionally alongside the deviation.
  negative_count       integer     NOT NULL,
  chain_supply_tokens  numeric,
  assets_supply_tokens numeric,
  -- |state − chain| / chain × 100. NULL whenever the check was skipped without a
  -- usable reference; still filled on a dust skip so it stays inspectable.
  deviation_pct        numeric,
  -- (/v4/assets − chain) / chain × 100 — rwa.xyz's own gap, informational only.
  assets_delta_pct     numeric,
  -- chain supply × NAV; what the $1M dust floor is judged on.
  notional_usd         numeric,
  threshold_pct        numeric     NOT NULL,
  -- Whether RECONCILE_STRICT=1 was set for this run (a warn was fatal).
  strict               boolean     NOT NULL DEFAULT false,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_slug, network, recorded_at)
);

-- RLS deliberately left DISABLED to match behavior_history. Do not enable.

GRANT ALL ON TABLE public.reconciliation_history TO anon, authenticated, service_role;
