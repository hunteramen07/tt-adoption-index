/**
 * Solana JSON-RPC plumbing — endpoint list, per-call fallback + retry, and the
 * typed method wrappers built on it.
 *
 * Lifted verbatim out of solana-resolve.ts so the ATA→owner resolver and any other
 * chain read (token supply for the reconciliation tripwire) share ONE endpoint list
 * and ONE failure policy instead of drifting apart. Semantics are unchanged from the
 * in-resolver original: every endpoint is tried in order, RPC_ATTEMPTS_PER_ENDPOINT
 * times each, with a per-attempt timeout; only when EVERY endpoint fails does the
 * call throw. Nothing here ever guesses on failure — that is the caller's contract
 * (resolution refuses to key an address raw; the tripwire skips, never fabricates).
 */

const DEFAULT_RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
]

/** RPC endpoints, overridable via SOLANA_RPC_URLS (comma-separated). */
export function rpcEndpoints(): string[] {
  const env = process.env.SOLANA_RPC_URLS
  if (env) {
    const list = env.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length > 0) return list
  }
  return DEFAULT_RPC_ENDPOINTS
}

/** The subset of a jsonParsed account that resolution reads. */
export interface ParsedAccount {
  owner: string
  data?: { parsed?: { type?: string; info?: { owner?: string } } }
}

const RPC_TIMEOUT_MS = 30_000
const RPC_ATTEMPTS_PER_ENDPOINT = 2

/**
 * One JSON-RPC call with endpoint fallback + retry. `pick` extracts the typed
 * payload from `result`; returning undefined marks the response malformed, which
 * counts as a failed attempt (retried, then the next endpoint) exactly like an
 * HTTP or RPC error. Throws only if EVERY endpoint fails.
 */
async function solanaRpc<T>(
  method: string,
  params: unknown[],
  pick: (result: unknown) => T | undefined,
  endpoints: string[]
): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  let lastErr: Error | null = null
  for (const url of endpoints) {
    for (let attempt = 0; attempt < RPC_ATTEMPTS_PER_ENDPOINT; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        })
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} from ${url}`)
          continue
        }
        const j = (await res.json()) as { result?: unknown; error?: unknown }
        if (j.error) {
          lastErr = new Error(`RPC error from ${url}: ${JSON.stringify(j.error)}`)
          continue
        }
        const picked = pick(j.result)
        if (picked !== undefined) return picked
        lastErr = new Error(`malformed ${method} response from ${url}`)
      } catch (err) {
        lastErr = controller.signal.aborted ? new Error(`timeout after ${RPC_TIMEOUT_MS}ms from ${url}`) : (err as Error)
      } finally {
        clearTimeout(timeout)
      }
    }
  }
  throw new Error(
    `[solana-resolve] ${method} failed on all ${endpoints.length} endpoint(s): ${lastErr?.message ?? 'unknown'}`
  )
}

/** One getMultipleAccounts call (≤100 addresses) with endpoint fallback + retry.
 *  Throws if EVERY endpoint fails — resolution never guesses on RPC failure. */
export async function getMultipleAccounts(addresses: string[], endpoints: string[]): Promise<(ParsedAccount | null)[]> {
  return solanaRpc(
    'getMultipleAccounts',
    [addresses, { encoding: 'jsonParsed' }],
    (r) => (r as { value?: (ParsedAccount | null)[] } | undefined)?.value || undefined,
    endpoints
  )
}
