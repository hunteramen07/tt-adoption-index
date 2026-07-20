/**
 * Shared rwa.xyz HTTP layer — per-request timeout plus bounded exponential-backoff
 * retry over transient transport failures.
 *
 * Lifted verbatim out of transfers.ts so /v4/transactions and /v4/assets share one
 * retry policy rather than drifting apart. The error-message shapes are unchanged
 * (`rwa.xyz <endpoint> failed (page N): HTTP … `), parameterised only by endpoint,
 * so existing callers and their smoke/parity assertions see identical text.
 */

const REQUEST_TIMEOUT_MS = 90_000
// rwa.xyz occasionally returns a transport error (e.g. an upstream Databricks
// `connect ETIMEDOUT`, sometimes wrapped in a 400) or a 5xx mid-pagination;
// without retry a single bad page aborts the whole multi-chain run. Bounded
// exponential backoff, then fail loudly.
const MAX_PAGE_RETRIES = 3
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000]

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Transient (retryable) failures: any 5xx, plus the rwa.xyz case where an upstream
 * connect error (ETIMEDOUT/ECONNRESET/…) is surfaced as a 400 whose body carries
 * the transport error string. A "clean" 400/401/403/422 is a real client error and
 * is NOT retried — it would fail every attempt and should surface immediately.
 */
export function isRetryableHttp(status: number, body: string): boolean {
  if (status >= 500) return true
  if (status === 400 && /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|reason: connect/i.test(body)) {
    return true
  }
  return false
}

/**
 * Fetch one rwa.xyz JSON page with the per-request timeout AND a bounded
 * exponential-backoff retry over transient transport failures (timeout/abort,
 * 5xx, or a 400 wrapping an upstream connect error). A non-retryable HTTP error
 * throws immediately; exhausting the retries rethrows the last error.
 *
 * @param endpoint path used in error messages, e.g. '/v4/transactions'
 * @param page     page number used in error messages (pass 1 for single-page reads)
 */
export async function fetchRwaJson<T>(
  url: string,
  endpoint: string,
  page: number,
  apiKey: string
): Promise<T> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]
      console.log(
        `[rwa] retrying page ${page} (attempt ${attempt + 1}/${MAX_PAGE_RETRIES + 1}) after ${backoff}ms — ${lastErr?.message ?? ''}`
      )
      await sleep(backoff)
    }

    // Per-request timeout so a stalled page fails (and retries) instead of hanging.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch (err) {
      // Network error or timeout abort — transient; record and retry.
      lastErr = controller.signal.aborted
        ? new Error(`rwa.xyz ${endpoint} timed out (page ${page}) after ${REQUEST_TIMEOUT_MS}ms`)
        : (err as Error)
      continue
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      const body = await res.text()
      const err = new Error(`rwa.xyz ${endpoint} failed (page ${page}): HTTP ${res.status} — ${body}`)
      if (isRetryableHttp(res.status, body)) {
        lastErr = err
        continue
      }
      throw err // non-retryable client error — surface immediately
    }

    return (await res.json()) as T
  }
  throw lastErr ?? new Error(`rwa.xyz ${endpoint} failed (page ${page}) after ${MAX_PAGE_RETRIES + 1} attempts`)
}
