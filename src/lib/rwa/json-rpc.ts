/**
 * One JSON-RPC call with 429 backoff, endpoint fallback and retry — the failure
 * policy shared by every chain read (Solana getMultipleAccounts / getTokenSupply,
 * EVM eth_call).
 *
 * Order of operations per call:
 *   1. On the current endpoint, a 429 (HTTP status, or a JSON-RPC error that says
 *      "too many requests" / code -32429 — providers differ) is a PACING signal, not a
 *      dead endpoint: back off (Retry-After if given, else 1s → 2s → 4s → 8s) and retry
 *      the SAME endpoint, up to RPC_429_MAX_RETRIES times. The Solana resolver fires
 *      hundreds of unpaced getMultipleAccounts calls for a dense window (the 2024-10-18
 *      USDY spike needs 20-35k address lookups in one go); without this, one burst
 *      fell straight through to fallbacks that do not answer at all.
 *   2. Any other failure (5xx, network error, timeout, malformed) is retried
 *      RPC_ATTEMPTS_PER_ENDPOINT times on that endpoint, then the next endpoint.
 *   3. Only when EVERY endpoint fails does the call throw. Nothing here ever guesses on
 *      failure — that is the caller's contract (resolution refuses to key an address
 *      raw; the tripwire skips, never fabricates a reference).
 *
 * Lifted out of solana-rpc.ts (itself lifted verbatim out of solana-resolve.ts) so
 * the EVM reader does not grow a second, subtly different retry loop.
 */

const RPC_TIMEOUT_MS = 30_000
const RPC_ATTEMPTS_PER_ENDPOINT = 2
/** 429 retries on ONE endpoint before treating it as failed for this call. */
export const RPC_429_MAX_RETRIES = 4
export const RPC_429_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000]
/** Upper bound on an honoured Retry-After, so a hostile header cannot stall a run. */
const RPC_429_MAX_RETRY_AFTER_MS = 15_000

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
  /** Test hooks only — production callers leave these unset. */
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
}

/** A JSON-RPC error body that means "slow down" rather than "this call is wrong". */
export function isRateLimitRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: unknown; message?: unknown }
  if (e.code === 429 || e.code === -32429) return true
  return typeof e.message === 'string' && /too many requests|rate limit/i.test(e.message)
}

/** Backoff for the k-th (0-based) 429 retry: Retry-After (seconds or HTTP-date) when
 *  present and sane, else the fixed ladder. Exported for the unit test. */
export function backoffFor429(retryIndex: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader)
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfterHeader) - Date.now()
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, RPC_429_MAX_RETRY_AFTER_MS)
  }
  return RPC_429_BACKOFF_MS[Math.min(retryIndex, RPC_429_BACKOFF_MS.length - 1)]
}

/** Host-only form of an endpoint for logs: a keyed URL carries its key in the path or
 *  query, which must never reach a CI log. Unparseable ⇒ 'INVALID(<prefix>)'. */
export function redactEndpoint(url: string): string {
  try {
    const u = new URL(url)
    const keyed = u.pathname !== '/' || u.search !== ''
    return keyed ? `${u.host} (path/query redacted)` : u.host
  } catch {
    return `INVALID(${url.slice(0, 12)}…)`
  }
}

export async function jsonRpc<T>({ label, method, params, pick, endpoints, fetchImpl, sleepImpl }: JsonRpcCall<T>): Promise<T> {
  const doFetch = fetchImpl ?? fetch
  const sleep = sleepImpl ?? defaultSleep
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  let lastErr: Error | null = null
  for (const url of endpoints) {
    let attempts = 0
    let rateLimitRetries = 0
    while (attempts < RPC_ATTEMPTS_PER_ENDPOINT) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
      // Set when this attempt was a 429: it does not consume a regular attempt, it
      // consumes a backoff retry on the same endpoint.
      let retryAfter: string | null | undefined
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        })
        if (res.status === 429) {
          retryAfter = res.headers.get('retry-after')
          lastErr = new Error(`HTTP 429 from ${redactEndpoint(url)}`)
        } else if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} from ${redactEndpoint(url)}`)
          attempts++
          continue
        } else {
          const j = (await res.json()) as { result?: unknown; error?: unknown }
          if (j.error) {
            if (isRateLimitRpcError(j.error)) {
              retryAfter = null
              lastErr = new Error(`RPC rate-limit error from ${redactEndpoint(url)}: ${JSON.stringify(j.error)}`)
            } else {
              lastErr = new Error(`RPC error from ${redactEndpoint(url)}: ${JSON.stringify(j.error)}`)
              attempts++
              continue
            }
          } else {
            const picked = pick(j.result)
            if (picked !== undefined) return picked
            lastErr = new Error(`malformed ${method} response from ${redactEndpoint(url)}`)
            attempts++
            continue
          }
        }
      } catch (err) {
        lastErr = controller.signal.aborted
          ? new Error(`timeout after ${RPC_TIMEOUT_MS}ms from ${redactEndpoint(url)}`)
          : (err as Error)
        attempts++
        continue
      } finally {
        clearTimeout(timeout)
      }

      // Rate-limited: pace on THIS endpoint before giving up on it. Falling through to
      // the next endpoint on a 429 is wrong twice over — it abandons a working endpoint
      // for a pacing hiccup, and it fires another unpaced request somewhere else.
      if (rateLimitRetries >= RPC_429_MAX_RETRIES) {
        attempts = RPC_ATTEMPTS_PER_ENDPOINT // exhausted: next endpoint
        break
      }
      const wait = backoffFor429(rateLimitRetries, retryAfter ?? null)
      rateLimitRetries++
      console.warn(
        `${label} ${method}: rate-limited by ${redactEndpoint(url)} — backing off ${wait}ms ` +
        `(429 retry ${rateLimitRetries}/${RPC_429_MAX_RETRIES})`
      )
      await sleep(wait)
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
