# RTA Index — Project Status

**Last updated:** June 15, 2026
**Live site:** tt-adoption-index.vercel.app
**Repo:** github.com/hunteramen07/tt-adoption-index
**Built by:** Hunter Amen (Boston College CSOM '29), with Claude (verification) and Claude Code (implementation)

## ⚠️ Current state: mid-overhaul, publication on hold
The shipped site is Ethereum-only, methodology v1.1, monthly readings. A
6-stage overhaul is in progress (see Roadmap below). **Do not write or publish
public-facing content until recalibration is complete** — see Calibration note.
Most-recently completed: item 1, the index history tab.

## What this is
Public dashboard around the RTA Index — a 0–100 composite measuring
institutional adoption of tokenized U.S. Treasuries on Ethereum mainnet.
Current reading: **74.1 (May 2026), +13.0 vs April**, methodology v1.1,
41 monthly readings backfilled to Jan 2023. *(Reading is pre-recalibration;
see Calibration note — current numbers are not yet considered defensible.)*

## ⚠️ Calibration note (blocks publication)
The AUM-growth factor (range −40%→0, 0%→50, +65%→100) clamps at score 100 in
**11 of 38 scoreable months** — verified directly against `index_readings`,
June 2026. The +65% upper bound sits far below the mature-phase maximum: raw
3-month AUM growth in clamped months ranges from +66% up to +464% (and a
launch-phase +20,725% in Apr 2023). So the factor cannot distinguish "fast"
from "explosive" growth, which flattens real signal. The 2023 launch-phase
clamps are defensible per methodology (calibrated to mature-phase
distribution); the 2024 mature-phase clamps (Mar–Jul, Dec) are the open
problem. This is the central reason all six factors will be re-audited and
recalibrated once, at the end of the overhaul, against the final data shape.

## Coverage
Five funds, Ethereum mainnet, broadly-distributed share classes:
BUIDL (BlackRock), OUSG & USDY (Ondo), USTB (Superstate), USYC (Hashnote).
~$1.66B Ethereum AUM, ~1,170 holders. BENJI excluded (no Ethereum
deployment; activates with v2.0 multi-chain). BUIDL-I (restricted
institutional class, ~$829M / 6 holders) documented but excluded from
factor inputs — see methodology coverage note. Other four funds scanned:
no additional share classes.

## Architecture
- Next.js 16 + TypeScript + Tailwind + recharts, deployed on Vercel
  (auto-deploy from main)
- Supabase (Postgres): snapshots, index_readings, holder_classifications,
  holder_aggregate_stats
- Dune query 7696914: daily supply per product (cumulative mint/burn,
  full history, DECIMAL cast, VARCHAR output)
- Etherscan API: live supply, holders, transfers (bounded calls only)
- **Data flow:** local classify run (npm run classify) → Supabase →
  site reads Supabase. Behavioral/index data is as-of last run; market
  data (AUM, transfers) is live with 1h cache. Build makes zero API
  calls (all data pages render on-demand, Partial Prerender).
- NAVs hardcoded with navAsOf dates (BUIDL/USTB $1.00 distributing;
  OUSG $115.53, USDY/USYC $1.13 accumulating) — monthly manual refresh

## Pages
- `/` Overview (index hero, factor grid, fund table, total AUM chart)
- `/history` Index history — month list (newest first) + per-month factor
  detail at `/history/[month]`, composite-over-time chart. Renders factors
  dynamically from each reading's `factors` JSON (schema-flexible: survives
  the planned 3m→1m factor-key change without code edits; new `*1m` keys
  pre-registered in src/lib/index/factor-meta.ts). UI only — no methodology
  change, readings untouched at v1.1.
- `/holders` Holder behavior aggregates
- `/fund/[slug]` Per-fund detail
- `/methodology` Methodology + eligibility table
- `/roadmap` Roadmap

## Index methodology (v1.1)
Six factors: AUM growth 3m (25%), holder growth 3m (20%), concentration
trend 3m (20%, negated), dormancy trend 3m (15%, negated,
supply-weighted), transfer activity 30d-vs-3m ratio (10%, neutral=1.0),
breadth (10%). Piecewise linear normalization, 50=flat, clamped; ranges
calibrated on the 41-month backfill. v1.0→v1.1: dormancy aggregation
corrected to supply-weighted, all readings restated (changelog on
/methodology). NOTE: window will change 3m→1m and all ranges recalibrate
at the end of the overhaul → methodology v2.0.

## Holder behavior layer
Per-wallet 90-day classification (Accumulating/Active/Distributing/
Dormant). Verified against holder_aggregate_stats, classified 2026-06-11:

| Fund | Holders | Dormancy (supply-wtd) | Eligibility |
|------|--------:|----------------------:|-------------|
| BUIDL | 58  | 73.26% | QP, $5M min |
| OUSG  | 52  | 42.56% | accredited |
| USYC  | 35  | 28.06% | qualified |
| USDY  | 944 |  7.75% | $5K non-US |
| USTB  | 80  |  6.21% | accredited |

Key finding (VERIFIED): eligibility tracks dormancy. The clean hook is
BUIDL ~73% vs USTB ~6%; the *defensible* version is the full five-fund
gradient above — OUSG and USYC sit in the middle, so it's a gradient, not a
binary. Use the full spread in any published analysis.

IMPORTANT nuance for publication: `dormancy_share_pct` is SUPPLY-WEIGHTED,
not wallet-count. BUIDL is 21/58 dormant *wallets* (36%) but 73% of
*supply* — a few large dormant wallets. Any "73% dormancy" claim must state
it's supply-weighted, or a reader counting wallets will get 36% and cry foul.

DISCREPANCY to resolve: docs (METHODOLOGY.md) say USDY is "aggregate-only,
no per-wallet classification." But holder_aggregate_stats has a full
behavioral breakdown for USDY (542 dormant / 237 accum / 17 distrib / 148
active). Either the methodology text is stale or the pipeline is doing more
than documented. Reconcile before publishing the holder layer.

## Operating ritual (monthly, ~20 min, 1st of month)
1. Update NAVs in src/config/products.ts (navUsd + navAsOf) → push
2. npm run classify (writes classifications + aggregate stats)
3. Snapshot + index reading write (backfill script path)
4. Verify: new reading sane, spot-check dormancy, homepage shows new month

## Bug history (verification discipline record)
1. Hallucinated BENJI contract address (caught: manual Etherscan check)
2. SQL interval cut breaking cumulative supply (caught: vs live Etherscan)
3. Silent API failures cached as empty (caught: debug diagnostics)
4. NAV $1 assumption — OUSG off 116x (caught: vs rwa.xyz)
5. Next.js 16 API renames
6. Truncated transfer replay → garbage holder sets (caught twice: dev
   and production; fixed structurally by Supabase-read architecture)
7. Ghost rows from upsert-without-delete (fixed: post-upsert cleanup)
8. Methodology/implementation dormancy divergence → v1.1 restatement
9. OUSG 0.0% top-5 from rate-limited zero-supply cache
10. React key collision on multi-event transactions
11. classify.ts never wrote holder_aggregate_stats (latent; caught when
    site began reading the table)
Lesson encoded: verify every number against an independent source;
local success ≠ production success (warm cache masks incomplete fetches).

## Roadmap (6-item overhaul, in order — see ROADMAP.md / /roadmap)
Calibration is deliberately LAST so it's done once against the finished data
shape, not repeatedly.
1. ✅ Index history tab — read-only, schema-flexible. DONE (kept unpublicized
   per publication hold).
2. Automate classification via GitHub Actions — cadence scoped to what adds
   real signal for 90-day labels (nightly likely honest; sub-daily likely
   precision theater). NEXT.
3. Multi-chain support — structural keystone, methodology v2.0 (cross-chain
   holder dedup, per-chain contract verification, per-chain supply/NAV).
4. Expand coverage to top-10 tokenized-Treasury funds by rwa.xyz.
5. Single math pass: shift all 6 factors 3m→1m, add parallel fiscal-quarter
   composite (same 6 factors, own card beside live monthly reading), then
   audit every factor + recalibrate all ranges ONCE against final state
   (all chains, top-10 funds, 1m window).
6. Update methodology + project docs to match.

## Changelog (project releases — distinct from methodology version)
- 2026-06-15 — Added /history tab with per-month factor breakdown and
  composite-over-time chart. UI only; readings unchanged, methodology v1.1.
- (methodology versions tracked separately in METHODOLOGY.md: v1.0 initial,
  v1.1 supply-weighted dormancy restatement. Next methodology bump is v2.0
  at recalibration.)
