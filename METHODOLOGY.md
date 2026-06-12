# RWA Token Adoption Index (RTA Index) — Methodology v1.0

## Purpose
A single 0–100 score measuring institutional adoption of tokenized
real-world assets on public blockchains. Version 1 covers the tokenized
U.S. Treasury / money market segment — the largest and most data-rich
RWA category. Additional segments (private credit, commodities) are
planned for future versions.

A reading of 50 means adoption is flat; above 50, accelerating; below
50, contracting.

## Covered products (v1)
BlackRock BUIDL, Ondo OUSG, Ondo USDY, Superstate USTB, Hashnote USYC.
Franklin Templeton BENJI is temporarily excluded from v1: it has no
Ethereum mainnet deployment, and multi-chain support is planned for a
future version.

## Factors and weights

| # | Factor | Weight | Rationale |
|---|--------|--------|-----------|
| 1 | AUM growth (3-month) | 25% | Capital commitment is the primary evidence of adoption |
| 2 | Holder growth (3-month) | 20% | Breadth of participation, not just size of capital |
| 3 | Concentration trend (3-month) | 20% | Falling top-5 holder share distinguishes broad adoption from whale activity |
| 4 | Dormancy trend (3-month) | 15% | Falling share of untouched supply means capital is being used, not parked |
| 5 | Transfer activity | 10% | On-chain transfer volume relative to AUM; utilization velocity |
| 6 | Breadth | 10% | Count of live products and chains; slow-moving structural signal |

## Factor definitions
1. **AUM growth** — 3-month % change in total AUM across covered
   products. AUM = supply × per-product NAV. Distributing money-market
   products (BUIDL, USTB) hold ~$1 NAV; accumulating products (OUSG at
   ~$115, USDY/USYC at ~$1.13) accrue yield into the token price. NAVs
   are hardcoded with a navAsOf date, refreshed monthly; live price
   sources are planned for a future version.
2. **Holder growth** — 3-month % change in total distinct holder
   addresses across covered products.
3. **Concentration trend** — 3-month change in the average top-5 holder
   share of supply, averaged across products. Declining share scores
   positively.
4. **Dormancy trend** — 3-month change in the share of total supply held
   by addresses with no outbound transfer in the trailing 90 days.
   Declining dormancy scores positively.
5. **Transfer activity** — trailing 30-day on-chain transfer volume
   divided by AUM, compared to its 3-month average.
6. **Breadth** — number of live products and distinct chains hosting
   them, scored against the trailing year.

## Normalization
Each factor maps to a 0–100 score via a defined linear range, clamped
at the bounds (e.g., 3-month AUM growth: −40% → 0, 0% → 50, +65% → 100).
Exact ranges per factor are calibrated against backfilled historical
data so that the mature-phase distribution spans most of the 0–100 range,
and are fixed in code thereafter. Range changes require a methodology
version bump. Readings during the segment's launch phase (early 2023)
reflect launch dynamics and clamp at scale bounds; the index is calibrated
to the mature-phase distribution.

## Composite
Weighted arithmetic mean of the six factor scores. Factor sub-scores
are published alongside the composite. Computed monthly on the 1st for
the prior month; readings stored as snapshots. Historical readings are
backfilled from on-chain data.

## Holder Behavior Analysis (displayed metrics)
In addition to the index, the dashboard publishes wallet-level
behavioral profiles. Each holder address is classified over the
trailing 90 days as: Accumulating (net inflows), Distributing (net
outflows), Dormant (no movement), or Active (regular two-way flow).
Published aggregates: behavioral mix per product, average holding
period, dormancy share, net new vs. exited wallets per month.

Coverage tiers: full per-wallet classification for institutional
products (BUIDL, OUSG, USTB, USYC); aggregate flow statistics only for
USDY due to holder count and API constraints.

These profile metrics inform the Dormancy factor but the full
behavioral mix is not an index input in v1.0.

## Limitations
- **Custodial wallets:** each address is treated as one holder.
  Omnibus custodial structures may aggregate many beneficial owners,
  overstating concentration and dormancy. Publicly labeled addresses
  (exchanges, known custodians) are flagged where available.
- **Ethereum mainnet only:** v1 measures Ethereum mainnet adoption only.
  Ethereum's share of total product AUM ranges from ~3% (USYC) to ~51%
  (USDY) per rwa.xyz, so the index reflects Ethereum-chain adoption
  specifically. Multi-chain coverage is the next coverage expansion.
- **Per-token classification:** behavioral labels reflect flows of each
  token in isolation. Holders interacting with DeFi wrappers (e.g., Flux
  Finance's fOUSG for OUSG) may be classified as Distributing or
  Accumulating while their economic exposure is unchanged — the flow
  represents movement between the raw token and a wrapped position.
  Wrapper-aware classification is a candidate for future versions.
- The index measures on-chain observable adoption; off-chain records
  (transfer-agent ledgers) are out of scope.

## Data sources
Etherscan (holders, concentration, transfers, behavioral
classification), Dune Analytics (supply/AUM history), issuer
disclosures (minimums, eligibility, NAV).

## Versioning
v1.0 — June 2026. Factor additions, weight changes, or range
recalibrations increment the version and are documented in a changelog.

v1.1 — June 2026. Dormancy aggregation corrected from simple product
average to supply-weighted share of total segment supply, matching the
original factor definition ("share of total supply held by addresses with
no outbound transfer in the trailing 90 days"). Historical readings
restated.