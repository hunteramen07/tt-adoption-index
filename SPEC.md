# Tokenized Treasury Adoption Index — Project Spec

## Goal
A public dashboard centered on an "adoption index" — a single 0-100 score
measuring institutional adoption of tokenized U.S. Treasury products, with
supporting data. Audience: finance people. The homepage must pass a
30-second test: index score, change vs last month, trend at a glance.
Deployable on Vercel free tier.

## Tracked products (v1)
- BlackRock BUIDL, Ondo OUSG & USDY, Franklin Templeton BENJI,
  Superstate USTB, Hashnote USYC

## Stack
- Next.js 14+ (App Router), TypeScript, Tailwind
- Charts: recharts
- Data: Etherscan API (holders, top-holder concentration, transfers),
  Dune API (supply/AUM history)
- Supabase (Postgres) for monthly index snapshots
- Server-side fetching, ~1 hour cache revalidation
- API keys in .env.local, never committed

## Pages
1. `/` — index score (large), change vs last month, sparkline of index
   history; below: fund table (name, issuer, AUM, holders, top-5 holder
   share, chains) and total AUM chart
2. `/fund/[slug]` — per-fund detail: AUM history, holder count,
   concentration chart, 10 most recent large transfers (>$1M)
3. `/methodology` — index methodology (from METHODOLOGY.md) plus a table
   of minimum investments / eligibility per product

## Index
Computed exactly per METHODOLOGY.md. Monthly snapshots stored in Supabase.

## Principles
- Build incrementally, one feature per session; data layer before UI
- Typed API responses; graceful degradation (stale data + timestamp,
  never a crash)
- Institutional aesthetic: neutral palette, clean typography, no crypto-neon
- Every data point displays source and last-updated time
- Contract addresses live in one config file for manual verification

## Out of scope for v1
Auth, alerts, perps, non-treasury RWAs, mobile app