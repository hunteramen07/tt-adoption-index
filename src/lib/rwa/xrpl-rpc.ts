/**
 * XRP Ledger JSON-RPC — the issued supply of an IOU, read from the issuer's
 * obligations via `gateway_balances`. The reconciliation tripwire's independent
 * reference for XRPL networks (OUSG's largest chain: ~48% of the fund, 5 holders).
 *
 * WHY gateway_balances. On XRPL a token is not a contract with a totalSupply(); it is
 * a set of trust lines against an issuer account. `gateway_balances` on the issuer
 * sums every trust line's balance per currency — `obligations[currency]` IS the
 * circulating supply — straight from a validated ledger, sharing no pipeline with
 * rwa.xyz. Probe 2026-09-21: three public clusters agreed on 1,639,899.441472341
 * OUSG at ledger 107,149,571; rwa.xyz /v4/assets reported 1,639,899.4142968748 —
 * the difference is rwa.xyz's float32 rounding of XRPL amounts, well inside the
 * tripwire threshold.
 *
 * WIRE FORMAT. rippled's HTTP API is JSON-RPC-shaped but not JSON-RPC 2.0: the
 * request is `{method, params: [ {...} ]}` (it tolerates the `jsonrpc`/`id` fields
 * the shared helper adds — probe 2026-09-21), and the reply is `{result: {...,
 * status: 'success' | 'error', error?: string}}` — errors live INSIDE `result`, never
 * as a top-level `error` object. `pick` therefore treats a non-success status as a
 * malformed reply, which the shared policy retries and then fails over, exactly like
 * an RPC error. One subtlety: an UNKNOWN account still answers status 'success' with
 * no `obligations` key at all, so a missing obligations map is an error here, never
 * a zero supply.
 *
 * CURRENCY CODES. A currency key is the plain 3-character ISO-style code ('USD') or,
 * for anything longer, the ASCII bytes hex-encoded and right-padded with zeros to 40
 * hex characters ('OUSG' → '4F55534700000000000000000000000000000000'). The product's
 * `symbol` selects the obligation; every other code the issuer carries is ignored.
 *
 * PRECISION. Obligations are decimal strings (XRPL keeps 16 significant digits). They
 * are converted to raw base units at the CONFIGURED decimals by exact string
 * arithmetic; digits beyond that precision are truncated (never rounded up), which is
 * far below any threshold in use. There is no on-chain decimals field to assert
 * against — XRPL amounts are not integer-scaled — so the config value is trusted here
 * where every other chain read asserts it.
 *
 * Endpoints: XRPL_RPC_URLS (comma-separated) or the public clusters below. Failure
 * policy is json-rpc.ts: 429 backoff on the same endpoint, two attempts, then the
 * next, and a throw only when every endpoint fails — never a guess.
 */

import { jsonRpc, endpointsFromEnv } from '@/src/lib/rwa/json-rpc'

/** rwa.xyz network_id for XRP Ledger. */
export const XRPL_NETWORK_ID = 46

const DEFAULT_XRPL_ENDPOINTS = ['https://xrplcluster.com', 'https://s1.ripple.com:51234', 'https://s2.ripple.com:51234']

/** RPC endpoints, overridable via XRPL_RPC_URLS (comma-separated). */
export function xrplEndpoints(): string[] {
  return endpointsFromEnv('XRPL_RPC_URLS') ?? DEFAULT_XRPL_ENDPOINTS
}

/** The `obligations` key rippled uses for a currency code (see header). */
export function xrplCurrencyKey(symbol: string): string {
  if (symbol.length === 3) return symbol
  const hex = Buffer.from(symbol, 'ascii').toString('hex').toUpperCase()
  return hex.padEnd(40, '0')
}

/** Human-readable form of an obligations key, for logs and errors. */
export function decodeXrplCurrency(key: string): string {
  if (!/^[0-9A-F]{40}$/i.test(key)) return key
  const text = Buffer.from(key, 'hex').toString('ascii').replace(/\0+$/, '')
  return /^[\x20-\x7e]+$/.test(text) ? text : key
}

/**
 * Exact decimal-string → raw base units at `decimals`. Truncates digits beyond
 * `decimals`; rejects anything that is not a plain unsigned decimal.
 */
export function decimalStringToRaw(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value)
  if (!m) throw new Error(`[xrpl-rpc] not a decimal amount: ${JSON.stringify(value)}`)
  const whole = m[1]
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole + frac)
}

export interface XrplIssuedSupply {
  /** Raw base units at the configured decimals, exact. */
  supplyRaw: bigint
  /** The obligations key that was read (for the persisted reference note). */
  currencyKey: string
  /** Validated ledger the figure comes from. */
  ledgerIndex: number
}

interface GatewayBalancesResult {
  status?: string
  error?: string
  ledger_index?: number
  obligations?: Record<string, string>
}

/**
 * The issuer's total obligation in `symbol`, from a validated ledger. Throws when
 * every endpoint fails, when the reply carries no obligations (unknown account, or an
 * issuer that has nothing outstanding — treated as "no reference", never as 0), or
 * when the issuer does not carry this currency at all.
 */
export async function xrplIssuedSupply(
  issuer: string,
  symbol: string,
  decimals: number,
  endpoints: string[] = xrplEndpoints(),
  fetchImpl?: typeof fetch
): Promise<XrplIssuedSupply> {
  const r = await jsonRpc<{ obligations: Record<string, string>; ledgerIndex: number }>({
    label: '[xrpl-rpc]',
    method: 'gateway_balances',
    params: [{ account: issuer, ledger_index: 'validated', strict: true }],
    pick: (result) => {
      const g = result as GatewayBalancesResult | undefined
      if (!g || g.status !== 'success') return undefined
      if (!g.obligations || typeof g.ledger_index !== 'number') return undefined
      return { obligations: g.obligations, ledgerIndex: g.ledger_index }
    },
    endpoints,
    fetchImpl,
  })
  const key = xrplCurrencyKey(symbol)
  const hit = Object.entries(r.obligations).find(([k]) => k.toUpperCase() === key.toUpperCase())
  if (!hit) {
    const carried = Object.keys(r.obligations).map(decodeXrplCurrency).join(', ') || 'none'
    throw new Error(`[xrpl-rpc] issuer ${issuer} carries no ${symbol} obligation (currencies: ${carried})`)
  }
  return { supplyRaw: decimalStringToRaw(hit[1], decimals), currencyKey: hit[0], ledgerIndex: r.ledgerIndex }
}
