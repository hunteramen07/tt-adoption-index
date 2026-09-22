/**
 * Chain-coverage check — notices when a tracked fund is live on a network we do not
 * track, before its supply and holders go silently missing from the index.
 *
 * WHY. Nothing compared rwa.xyz's per-network token list against products.ts.
 * USDY alone introduced seven networks (Stellar, Sei, Mantle, MANTRA, Plume, Noble,
 * Sui) that only a hand-built matrix (_local/contract-matrix.md) caught, and the
 * open question "when do we re-probe rwa for coverage?" had no answer. This is the
 * automated version of that matrix: one /v4/assets read per fund (the nightly makes
 * it anyway — the same token list feeds the market-value weight), compared by
 * (network_id, address) against config.
 *
 * DETECTION ONLY. Enabling a network stays a manual, reviewed step, because every
 * new chain this month needed a pre-enable check: per-token decimals (the fund-level
 * fallback would mis-scale by 10^n), address casing (base58/base32 must not be
 * lowercased), the mint/burn counterparty convention (four shapes seen so far, and
 * the normalizer THROWS on a fifth), the feed's shape, and whether a chain-supply
 * reference exists (else the tripwire is blind there). What this module does
 * instead is run that check READ-ONLY — three extra requests, only when a material
 * new network appears — and print a ready-to-review config proposal with the
 * answers filled in and the open items named.
 *
 * FOUR STATES, not two. A network absent from config is a genuine finding. One
 * present with every token behaviorallyObservable:false was excluded on purpose
 * (Noble, Sui, MANTRA) and gets a quieter re-check line. One present, observable,
 * but not yet in BACKFILL_ALLOWED / the nightly set is configured-but-not-enabled.
 * And an unconfigured ADDRESS on a configured network is a different signal again
 * (BUIDL-I is deliberately untracked; USDY's deprecated Ethereum contract is
 * deliberately tracked), so it needs its own allowlist or it would fire nightly.
 *
 * MATERIALITY. rwa.xyz's dollar value at or above the tripwire's $1M floor, with
 * supply × configured NAV as the fallback where rwa reports no dollar value (BUIDL,
 * USTB return 0). A newly listed network can arrive with null stats; it is reported
 * as immaterial-unknown rather than dropped, since that is the earliest signal.
 *
 * Pure evaluation + rendering; the probe primitives are injected so it runs offline.
 */

import type { Product } from '@/src/config/products'
import { isCaseSensitive, isIssuerLedger } from '@/src/config/networks'
import { evmEndpoints } from '@/src/lib/rwa/evm-rpc'
import { SOLANA_NETWORK_ID } from '@/src/lib/rwa/solana-resolve'
import { XRPL_NETWORK_ID } from '@/src/lib/rwa/xrpl-rpc'
import type { RwaAssetToken } from '@/src/lib/rwa/assets'
import type { RwaTransaction } from '@/src/lib/rwa/transfers'

/** Dollar value at or above which an untracked deployment is material. Same floor as
 *  the reconciliation tripwire's dust rule. */
export const COVERAGE_MATERIAL_USD = 1_000_000

/**
 * rwa.xyz token addresses that are deliberately NOT tracked although they sit on a
 * configured network. Keyed by fund slug, lowercased. Add here with a reason, never
 * silently — an entry is a product decision.
 */
export const KNOWN_UNTRACKED_ADDRESSES: Record<string, ReadonlyArray<{ address: string; reason: string }>> = {
  // Restricted share class, ~5× the tracked class; excluded by the Stage-0 config
  // spec (_local/stage0-multichain-config-spec.md) and by fetchTransfersRWA's
  // address post-filter.
  buidl: [{ address: '0x6a9da2d710bb9b700acde7cb81f10f1ff8c89041', reason: 'BUIDL-I restricted share class' }],
}

export type CoverageState =
  | 'covered'
  | 'configured_not_enabled'
  | 'excluded_network'
  | 'unconfigured_address'
  | 'unconfigured_network'

export interface CoverageFinding {
  productSlug: string
  state: CoverageState
  networkId: number
  /** rwa.xyz's slug when the response carries one, else derived from the name (flagged). */
  networkSlug: string
  networkSlugDerived: boolean
  networkName: string | null
  /** rwa.xyz's address, ORIGINAL casing (the value a proposal must copy). */
  address: string
  decimals: number
  supplyTokens: number | null
  valueUsd: number | null
  /** Where valueUsd came from, for the log line. */
  valueSource: 'rwa' | 'nav' | null
  holders: number | null
  material: boolean
  note?: string
}

export interface CoverageOptions {
  /** Funds the nightly runs through the rwa.xyz path. */
  multichainSlugs: ReadonlySet<string>
  /** Network slugs enabled for the chunked backfill, per fund. */
  backfillAllowed: Readonly<Record<string, readonly string[]>>
  /** Configured NAV for the supply × NAV fallback; null when the product has none. */
  navUsd: number | null
  materialUsd?: number
}

const slugify = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Pure. One finding per rwa.xyz token entry. */
export function evaluateCoverage(product: Product, tokens: readonly RwaAssetToken[], opts: CoverageOptions): CoverageFinding[] {
  const materialUsd = opts.materialUsd ?? COVERAGE_MATERIAL_USD
  const byNetwork = new Map<number, { slug: string; addresses: Map<string, boolean>; anyObservable: boolean }>()
  for (const t of product.tokens ?? []) {
    const e = byNetwork.get(t.networkId) ?? { slug: t.networkSlug, addresses: new Map<string, boolean>(), anyObservable: false }
    e.addresses.set(t.address.toLowerCase(), t.behaviorallyObservable)
    e.anyObservable ||= t.behaviorallyObservable
    byNetwork.set(t.networkId, e)
  }
  const untracked = new Map((KNOWN_UNTRACKED_ADDRESSES[product.slug] ?? []).map((u) => [u.address.toLowerCase(), u.reason]))
  const enabledNetworks = new Set(opts.backfillAllowed[product.slug] ?? [])
  const onNightly = opts.multichainSlugs.has(product.slug)

  const out: CoverageFinding[] = []
  for (const tok of tokens) {
    const cfg = byNetwork.get(tok.network_id)
    const addrLower = tok.address.toLowerCase()
    const supply = tok.total_supply_token?.val ?? null
    const rwaValue = tok.market_value_dollar?.val ?? null
    let valueUsd: number | null = null
    let valueSource: CoverageFinding['valueSource'] = null
    if (rwaValue != null && rwaValue > 0) {
      valueUsd = rwaValue
      valueSource = 'rwa'
    } else if (supply != null && opts.navUsd != null) {
      valueUsd = supply * opts.navUsd
      valueSource = 'nav'
    }
    const base = {
      productSlug: product.slug,
      networkId: tok.network_id,
      networkSlug: tok.network?.slug ?? (cfg?.slug ?? slugify(tok.network_name ?? `network-${tok.network_id}`)),
      networkSlugDerived: !tok.network?.slug && !cfg,
      networkName: tok.network_name,
      address: tok.address,
      decimals: tok.decimals,
      supplyTokens: supply,
      valueUsd,
      valueSource,
      holders: tok.holding_addresses_count?.val ?? null,
      material: valueUsd != null && valueUsd >= materialUsd,
    }
    if (!cfg) {
      out.push({ ...base, state: 'unconfigured_network' })
    } else if (cfg.addresses.has(addrLower)) {
      if (!cfg.addresses.get(addrLower)) {
        // Configured on purpose as NOT observable (Noble, Sui, MANTRA): a deliberate
        // exclusion, re-surfaced quietly so the re-check question has an answer.
        out.push({ ...base, state: 'excluded_network', note: 'configured as not behaviorally observable' })
      } else {
        const enabled = onNightly || enabledNetworks.has(cfg.slug)
        out.push({ ...base, state: enabled ? 'covered' : 'configured_not_enabled' })
      }
    } else if (!cfg.anyObservable) {
      out.push({ ...base, state: 'excluded_network', note: 'network configured as not behaviorally observable' })
    } else if (untracked.has(addrLower)) {
      out.push({ ...base, state: 'covered', note: `known untracked: ${untracked.get(addrLower)}` })
    } else {
      out.push({ ...base, state: 'unconfigured_address' })
    }
  }
  return out
}

// ── Read-only probe of a newly seen network ──────────────────────────────────

export interface NetworkProbe {
  earliestDate: string | null
  records: number
  pages: number
  latest: RwaTransaction[]
}

export interface ProbeFns {
  earliestTxDate(assetId: number, networkId: number): Promise<string | null>
  countWindow(assetId: number, networkId: number, gte: string, lt: string): Promise<{ records: number; pages: number }>
  latestTransactions(assetId: number, networkId: number, n: number): Promise<RwaTransaction[]>
}

/** Three requests: earliest date, exact record count, the latest 400 records. */
export async function probeNetwork(assetId: number, networkId: number, fns: ProbeFns, todayDay: string): Promise<NetworkProbe> {
  const earliestDate = await fns.earliestTxDate(assetId, networkId)
  if (!earliestDate) return { earliestDate: null, records: 0, pages: 0, latest: [] }
  const tomorrow = new Date(Date.parse(todayDay) + 86_400_000).toISOString().slice(0, 10)
  const { records, pages } = await fns.countWindow(assetId, networkId, earliestDate, tomorrow)
  const latest = await fns.latestTransactions(assetId, networkId, 400)
  return { earliestDate, records, pages, latest }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Which of the known counterparty shapes a mint/burn side shows. */
function counterpartyShape(value: string | null, tokenAddress: string): 'null' | 'zero-address' | 'token-address' | 'other' {
  if (value == null) return 'null'
  if (value === ZERO_ADDRESS) return 'zero-address'
  if (value.toLowerCase() === tokenAddress.toLowerCase()) return 'token-address'
  return 'other'
}

/** Address-encoding guess from the token address alone; every line says "verify". */
function encodingHint(address: string): { caseSensitive: boolean | null; issuerLedger: boolean | null; family: string } {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return { caseSensitive: false, issuerLedger: false, family: 'EVM hex' }
  if (/^0x[0-9a-fA-F]{64}$/.test(address)) return { caseSensitive: false, issuerLedger: false, family: 'Aptos/Sui hex' }
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) return { caseSensitive: true, issuerLedger: true, family: 'XRPL base58 issuer' }
  if (/^[A-Z0-9]{1,12}-G[A-Z2-7]{55}-\d+$/.test(address)) return { caseSensitive: true, issuerLedger: true, family: 'Stellar CODE-ISSUER-N' }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return { caseSensitive: true, issuerLedger: false, family: 'base58 (Solana-like)' }
  if (/^[a-z]+1[a-z0-9]{38,}$/.test(address)) return { caseSensitive: false, issuerLedger: false, family: 'bech32 (Cosmos-like)' }
  return { caseSensitive: null, issuerLedger: null, family: 'unknown' }
}

function chainReferenceFor(networkId: number): string {
  if (networkId === SOLANA_NETWORK_ID) return 'solana:getTokenSupply (exists)'
  if (networkId === XRPL_NETWORK_ID) return 'xrpl:gateway_balances (exists)'
  if (evmEndpoints(networkId)) return 'evm:totalSupply (endpoint configured in evm-rpc.ts)'
  return 'NONE — add an entry to evm-rpc.ts DEFAULT_EVM_ENDPOINTS or an adapter, or the tripwire skips this network'
}

/**
 * The ready-to-review proposal for one unconfigured network: a tokens[] line with
 * rwa.xyz's values, the registry lines the address shape implies, what the feed's
 * mint/burn convention looks like, and every item that still needs a human.
 */
export function renderProposal(f: CoverageFinding, probe: NetworkProbe | null): string {
  const hint = encodingHint(f.address)
  const lines: string[] = []
  const push = (s: string) => lines.push(s)

  push(`── proposal: ${f.productSlug} on ${f.networkSlug} (rwa.xyz network_id ${f.networkId}${f.networkName ? `, "${f.networkName}"` : ''}) ──`)
  push(`supply ${f.supplyTokens == null ? 'n/a' : f.supplyTokens.toLocaleString()} tokens` +
    `${f.valueUsd == null ? '' : ` ≈ $${Math.round(f.valueUsd).toLocaleString()} (${f.valueSource === 'rwa' ? 'rwa.xyz value' : 'supply × config NAV'})`}` +
    `${f.holders == null ? '' : `, ${f.holders} holders`}`)
  if (probe) {
    push(probe.earliestDate
      ? `history: ${probe.records.toLocaleString()} records since ${probe.earliestDate} (${probe.pages} page(s) at 1000/page) — ` +
        (probe.pages > 40 ? 'CHUNKED backfill territory' : 'a direct pull')
      : 'history: no transactions on rwa.xyz yet')
  }
  push('')
  push('// products.ts → tokens[] (values copied from rwa.xyz; verify each):')
  push(`{ networkId: ${f.networkId}, networkSlug: '${f.networkSlug}'${f.networkSlugDerived ? ' /* slug DERIVED from the name — verify against rwa.xyz */' : ''}, ` +
    `address: '${f.address}', behaviorallyObservable: true, decimals: ${f.decimals} },`)
  push('')
  push('// registries (src/config/networks.ts, evm-rpc.ts) — from the address shape alone:')
  const cs = hint.caseSensitive
  push(`//   address family     : ${hint.family}`)
  push(`//   case-sensitivity   : ${cs == null ? 'UNKNOWN — decide before enabling' : cs ? `case-SENSITIVE → add ${f.networkId} to CASE_SENSITIVE_NETWORK_IDS` : 'case-insensitive (safe to lowercase)'}` +
    `${isCaseSensitive(f.networkId) ? ' [already registered]' : ''}`)
  push(`//   issuer ledger      : ${hint.issuerLedger == null ? 'UNKNOWN' : hint.issuerLedger ? `yes → add an ISSUER_OF_TOKEN_ADDRESS entry for ${f.networkId}` : 'no'}` +
    `${isIssuerLedger(f.networkId) ? ' [already registered]' : ''}`)
  push(`//   chain-supply ref   : ${chainReferenceFor(f.networkId)}`)
  push(`//   BACKFILL_ALLOWED   : add '${f.networkSlug}' under ${f.productSlug} once the items above are settled`)
  push('')
  if (probe && probe.latest.length > 0) {
    push(`// mint/burn convention on the latest ${probe.latest.length} records (normalizeTransaction must recognise it or it THROWS):`)
    const tally = new Map<string, number>()
    for (const tx of probe.latest) {
      const slug = tx.transaction_type?.slug ?? '(no type)'
      const tokenAddr = tx.token?.address ?? f.address
      const key = slug.includes('mint')
        ? `${slug}: from=${counterpartyShape(tx.from_address, tokenAddr)}`
        : slug.includes('burn')
          ? `${slug}: to=${counterpartyShape(tx.to_address, tokenAddr)}`
          : `${slug}${tx.from_address == null || tx.to_address == null ? ' (NULL counterparty on a non-mint/burn — will throw)' : ''}`
      tally.set(key, (tally.get(key) ?? 0) + 1)
    }
    for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) push(`//   ${String(n).padStart(4)} × ${k}`)
    const decimalsSeen = new Set(probe.latest.map((tx) => tx.token?.decimals).filter((d): d is number => typeof d === 'number'))
    if (decimalsSeen.size > 0 && !(decimalsSeen.size === 1 && decimalsSeen.has(f.decimals))) {
      push(`//   ⚠ token.decimals on the feed = {${[...decimalsSeen].join(', ')}} vs ${f.decimals} on /v4/assets — resolve before enabling (MANTRA-class anomaly)`)
    }
    push('')
  }
  push('// still needs a human: confirm the slug, the decimals against the chain, the issuance')
  push('// convention above against normalizeTransaction, and a chain-supply reference.')
  return lines.join('\n')
}

/** One line per finding for the log. */
export function describeFinding(f: CoverageFinding): string {
  const value = f.valueUsd == null ? 'value n/a' : `≈$${Math.round(f.valueUsd).toLocaleString()}`
  const supply = f.supplyTokens == null ? 'supply n/a' : `${f.supplyTokens.toLocaleString()} tokens`
  return `${f.productSlug}:${f.networkSlug} [${f.state}${f.material ? ', MATERIAL' : ''}] ${f.address} — ${supply}, ${value}` +
    `${f.holders == null ? '' : `, ${f.holders} holders`}${f.note ? ` (${f.note})` : ''}`
}

/**
 * GitHub Actions annotation, so a finding shows on the run summary instead of only
 * inside the log. No-op outside Actions. Newlines are percent-encoded per the spec.
 */
export function emitGitHubWarning(title: string, message: string): void {
  if (process.env.GITHUB_ACTIONS !== 'true') return
  const enc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  console.log(`::warning title=${enc(title).replace(/,/g, '%2C').replace(/:/g, '%3A')}::${enc(message)}`)
}
