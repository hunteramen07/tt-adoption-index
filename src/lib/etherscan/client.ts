// Etherscan deprecated /api (v1) in 2025; v2 requires chainid.
const BASE_URL = 'https://api.etherscan.io/v2/api'
const CHAIN_ID = '1' // Ethereum mainnet

// Free tier: 5 calls/sec. 210ms ≈ 4.8/sec with a small margin.
const MIN_INTERVAL_MS = 210

// Module-level scheduler. Updated synchronously before any await, so
// concurrent callers each claim a unique slot without a lock.
let scheduledAt = 0

export interface EtherscanRaw {
  httpStatus: number
  status: string
  message: string
  result: unknown
  error?: string
}

/**
 * Rate-limited Etherscan v2 API GET.
 *
 * Returns the `result` field on success, an empty array for "no records"
 * responses, or null on network/API errors. Logs the full raw response on
 * every call so failures are visible in the terminal.
 */
export async function etherscanGet<T>(
  params: Record<string, string>
): Promise<T | null> {
  const raw = await etherscanGetRaw(params)
  if (!raw.error && raw.status === '1') return raw.result as T

  const resultStr = String(raw.result ?? '')
  if (resultStr.startsWith('No ') || raw.message?.startsWith('No ')) {
    return [] as unknown as T
  }
  return null
}

/**
 * Like etherscanGet but returns the full raw response for diagnostics.
 * Always logs the response body regardless of success or failure.
 */
export async function etherscanGetRaw(
  params: Record<string, string>
): Promise<EtherscanRaw> {
  const apiKey = process.env.ETHERSCAN_API_KEY
  if (!apiKey) {
    const err = 'ETHERSCAN_API_KEY environment variable is not set'
    console.error('[etherscan]', err)
    return { httpStatus: 0, status: '0', message: err, result: null, error: err }
  }

  // Claim a time slot synchronously before any await
  const now = Date.now()
  scheduledAt = Math.max(scheduledAt + MIN_INTERVAL_MS, now)
  const wait = scheduledAt - now
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait))

  const url = new URL(BASE_URL)
  const allParams = { chainid: CHAIN_ID, ...params, apikey: apiKey }
  for (const [k, v] of Object.entries(allParams)) url.searchParams.set(k, v)

  let res: Response
  try {
    res = await fetch(url.toString(), { cache: 'no-store' })
  } catch (err) {
    const msg = `network error: ${err}`
    console.error('[etherscan]', params.action, msg)
    return { httpStatus: 0, status: '0', message: msg, result: null, error: msg }
  }

  let json: { status: string; message: string; result: unknown }
  try {
    json = await res.json()
  } catch (err) {
    const msg = `JSON parse error (HTTP ${res.status}): ${err}`
    console.error('[etherscan]', params.action, msg)
    return { httpStatus: res.status, status: '0', message: msg, result: null, error: msg }
  }

  const preview =
    Array.isArray(json.result)
      ? `[${json.result.length} items]`
      : String(json.result ?? '').slice(0, 80)
  console.log(
    `[etherscan] ${params.action} → status=${json.status} message="${json.message}" result=${preview}`
  )

  return {
    httpStatus: res.status,
    status: json.status,
    message: json.message,
    result: json.result,
  }
}
