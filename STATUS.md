# RTA Index — Project Status

**Last updated:** June 12, 2026
**Live site:** tt-adoption-index.vercel.app
**Repo:** github.com/hunteramen07/tt-adoption-index
**Built by:** Hunter Amen (Boston College CSOM '29), with Claude (verification) and Claude Code (implementation)

## What this is
Public dashboard around the RTA Index — a 0–100 composite measuring
institutional adoption of tokenized U.S. Treasuries on Ethereum mainnet.
Current reading: **74.1 (May 2026), +13.0 vs April**, methodology v1.1,
41 monthly readings backfilled to Jan 2023.

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

## Index methodology (v1.1)
Six factors: AUM growth 3m (25%), holder growth 3m (20%), concentration
trend 3m (20%, negated), dormancy trend 3m (15%, negated,
supply-weighted), transfer activity 30d-vs-3m ratio (10%, neutral=1.0),
breadth (10%). Piecewise linear normalization, 50=flat, clamped; ranges
calibrated on the 41-month backfill. v1.0→v1.1: dormancy aggregation
corrected to supply-weighted, all readings restated (changelog on
/methodology).

## Holder behavior layer
Per-wallet 90-day classification (Accumulating/Active/Distributing/
Dormant) for BUIDL/OUSG/USTB/USYC; USDY aggregate-only (~950 holders).
Key finding: eligibility determines behavior — BUIDL ($5M QP minimum)
~73% dormancy vs USTB ~6%; USDY ($5K non-US) behaves payments-like.
Eligibility table (minimums/investor class/access) on /methodology,
researched from issuer sites June 2026.

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

## Roadmap (see ROADMAP.md / /roadmap)
Phase 1: automated daily classification via GitHub Actions (next)
Phase 2: multi-chain + BENJI + share-class review → methodology v2.0
Phase 3: more funds, live NAV, wrapper-aware classification
Phase 4: perps comparison dashboard
