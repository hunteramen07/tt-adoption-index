const BASE_URL = 'https://api.dune.com/api/v1'

export interface DuneSupplyRow {
  contract_address: string
  /** "YYYY-MM-DD 00:00:00.000 UTC" */
  day: string
  /** Raw integer supply; may arrive as number or string depending on magnitude */
  supply_raw: string | number
}

export interface DuneQueryResults {
  execution_id: string
  query_id: number
  /** e.g. "QUERY_STATE_COMPLETED" */
  state: string
  result: {
    rows: DuneSupplyRow[]
    metadata: {
      column_names: string[]
      result_set_bytes: number
      total_row_count: number
      datapoint_count: number
    }
  } | null
}

/**
 * Returns the latest saved results for a Dune query without triggering a
 * new execution.  Uses GET /v1/query/{id}/results.
 */
export async function duneGetLatestResults(
  queryId: number
): Promise<DuneQueryResults | null> {
  const apiKey = process.env.DUNE_API_KEY
  if (!apiKey) {
    console.error('[dune] DUNE_API_KEY is not set')
    return null
  }

  const url = `${BASE_URL}/query/${queryId}/results`

  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'X-DUNE-API-KEY': apiKey },
      cache: 'no-store',
    })
  } catch (err) {
    console.error('[dune] network error:', err)
    return null
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`[dune] HTTP ${res.status}:`, body.slice(0, 200))
    return null
  }

  let json: DuneQueryResults
  try {
    json = await res.json()
  } catch (err) {
    console.error('[dune] JSON parse error:', err)
    return null
  }

  console.log(
    `[dune] query ${queryId} → state=${json.state}` +
      ` rows=${json.result?.metadata?.total_row_count ?? 'n/a'}`
  )
  return json
}
