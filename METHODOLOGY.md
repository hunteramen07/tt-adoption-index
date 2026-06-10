# Adoption Index Methodology (DRAFT v0)

## Factors and weights
1. AUM growth (30%) — 3-month growth rate of total AUM across products
2. Holder growth (25%) — 3-month growth in distinct holder count
3. Concentration trend (25%) — change in average top-5 holder share
   (falling concentration = positive)
4. Breadth (20%) — number of live products and chains

## Normalization
Each factor scored 0-100 against its trailing 12-month range, then
weight-averaged into the index.

## Cadence
Monthly readings, stored as snapshots.

## Data sources
Etherscan (holders, concentration), Dune (supply/AUM history),
issuer disclosures (minimums/eligibility).