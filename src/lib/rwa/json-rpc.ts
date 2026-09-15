/**
 * One JSON-RPC call with endpoint fallback + retry — the failure policy shared by
 * every chain read (Solana getMultipleAccounts / getTokenSupply, EVM eth_call).
 *
 * Every endpoint is tried in order, RPC_ATTEMPTS_PER_ENDPOINT times each, with a
 * per-attempt timeout; only when EVERY endpoint fails does the call throw. Nothing
 * here ever guesses on failure — that is the caller's contract (resolution refuses
 * to key an address raw; the tripwire skips, never fabricates a reference).
 *
 * Lifted out of solana-rpc.ts (itself lifted verbatim out of solana-resolve.ts) so
 * the EVM reader does not grow a second, subtly different retry loop.
 */

const RPC_TIMEOUT_MS = 30_000
const RPC_ATTEMPTS_PER_ENDPOINT = 2

export interface JsonRpcCall<T> {
  /** Prefix for the all-endpoints-failed error, e.g. '[solana-resolve]'. */
  label: string
  method: string
  params: unknown[]
  /**
   * Extracts the typed payload from `result`. Returning undefined marks the
   * response malformed, which counts as a failed attempt (retried, then the next
   * endpoint) exactly like an HTTP or RPC error.
   */
  pick: (result: unknown) => T | undefined
  endpoints: string[]
}

export async function jsonRpc<T>({ label, method, params, pick, endpoints }: JsonRpcCall<T>): Promise<T> {
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
  throw new Error(`${label} ${method} failed on all ${endpoints.length} endpoint(s): ${lastErr?.message ?? 'unknown'}`)
}

/** Comma-separated endpoint list from an env var, or null when unset/empty. */
export function endpointsFromEnv(name: string): string[] | null {
  const env = process.env[name]
  if (!env) return null
  const list = env.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length > 0 ? list : null
}
