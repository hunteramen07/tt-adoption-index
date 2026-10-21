/**
 * Dune API client — used ONLY by scripts/refresh-dune.ts.
 *
 * Nothing on the request path (homepage, /api/debug) or in the monthly index
 * backfill talks to Dune any more: both read the persisted series in Supabase
 * `aum_history` (src/lib/dune/aumStore.ts). Dune's datapoint quota is charged on
 * every row read, and the site's hourly full-result reads (4,064 rows × 3 columns
 * = 12,192 datapoints each) exhausted it on 2026-09-24, taking the homepage AUM
 * chart and the 2026-10-01 monthly reading down with it. The nightly refresh now
 * reads a week of rows, once.
 *
 * Every function THROWS on a non-2xx response (DuneHttpError carries the status
 * and body) rather than returning null — a 402 must stop the refresh loudly.
 */

const BASE_URL = 'https://api.dune.com/api/v1'

export interface DuneSupplyRow {
  contract_address: string
  /** "YYYY-MM-DD 00:00:00.000 UTC" */
  day: string
  /** Raw integer supply; may arrive as number or string depending on magnitude */
  supply_raw: string | number
}

export interface DuneResultMetadata {
  column_names: string[]
  /** Rows in THIS page. */
  row_count: number
  /** Rows in the whole (filtered) result. */
  total_row_count: number
  result_set_bytes: number
  /** Datapoints charged for THIS page (rows × columns returned). */
  datapoint_count: number
}

export interface DuneResultsPage {
  execution_id: string
  query_id: number
  is_execution_finished: boolean
  /** e.g. "QUERY_STATE_COMPLETED" */
  state: string
  submitted_at?: string
  execution_started_at?: string
  execution_ended_at?: string
  expires_at?: string
  result: { rows: DuneSupplyRow[]; metadata: DuneResultMetadata } | null
  /** Present when more rows follow; absent on the last page. */
  next_offset?: number
  next_uri?: string
}

export interface DuneExecutionStatus {
  execution_id: string
  query_id: number
  state: string
  is_execution_finished: boolean
  submitted_at?: string
  execution_started_at?: string
  execution_ended_at?: string
}

export interface DuneResultsOptions {
  /** SQL WHERE-style expression, e.g. `day >= '2026-09-15'`. Strings/dates single-quoted. */
  filters?: string
  /** SQL ORDER BY-style, e.g. `day` or `day desc`. */
  sortBy?: string
  limit?: number
  offset?: number
  /** Return only these columns — fewer columns, fewer datapoints charged. */
  columns?: string[]
}

export class DuneHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    url: string
  ) {
    super(`Dune HTTP ${status} on ${url}: ${body.slice(0, 300)}`)
    this.name = 'DuneHttpError'
  }
  /** The datapoint/credit cap — "would exceed your configured datapoint limit per billing cycle". */
  get isQuotaExceeded(): boolean {
    return this.status === 402
  }
}

function apiKey(): string {
  const key = process.env.DUNE_API_KEY
  if (!key) throw new Error('[dune] DUNE_API_KEY is not set')
  return key
}

async function duneFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${BASE_URL}${path}`
  const res = await fetch(url, {
    ...init,
    headers: { 'X-DUNE-API-KEY': apiKey(), 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new DuneHttpError(res.status, body, url)
  }
  return (await res.json()) as T
}

function resultsQuery(opts: DuneResultsOptions): string {
  const q = new URLSearchParams()
  if (opts.filters) q.set('filters', opts.filters)
  if (opts.sortBy) q.set('sort_by', opts.sortBy)
  if (opts.limit !== undefined) q.set('limit', String(opts.limit))
  if (opts.offset !== undefined) q.set('offset', String(opts.offset))
  if (opts.columns?.length) q.set('columns', opts.columns.join(','))
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** POST /query/{id}/execute — starts a fresh execution (costs credits, not datapoints). */
export async function duneExecuteQuery(queryId: number): Promise<{ execution_id: string; state: string }> {
  return duneFetch(`/query/${queryId}/execute`, { method: 'POST', body: '{}' })
}

/** GET /execution/{id}/status — free; poll until is_execution_finished. */
export async function duneGetExecutionStatus(executionId: string): Promise<DuneExecutionStatus> {
  return duneFetch(`/execution/${executionId}/status`)
}

/** GET /execution/{id}/results — charged per datapoint RETURNED, so filter and page. */
export async function duneGetExecutionResults(
  executionId: string,
  opts: DuneResultsOptions = {}
): Promise<DuneResultsPage> {
  return duneFetch(`/execution/${executionId}/results${resultsQuery(opts)}`)
}

/**
 * GET /query/{id}/results — the latest SAVED execution's rows without triggering a
 * new execution. Same datapoint charging as the execution endpoint.
 */
export async function duneGetLatestResults(
  queryId: number,
  opts: DuneResultsOptions = {}
): Promise<DuneResultsPage> {
  return duneFetch(`/query/${queryId}/results${resultsQuery(opts)}`)
}
