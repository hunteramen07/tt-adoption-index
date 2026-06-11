import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: SupabaseClient<any> | null = null

/**
 * Returns a singleton Supabase client.
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY when available (server-side scripts that need
 * write access without RLS). Falls back to NEXT_PUBLIC_SUPABASE_ANON_KEY.
 *
 * Note: NEXT_PUBLIC_SUPABASE_URL may have a trailing /rest/v1/ copied from the
 * Supabase dashboard — the client expects just the base project URL, so we strip it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSupabase(): SupabaseClient<any> {
  if (_client) return _client

  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!rawUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  const key = serviceKey ?? anonKey
  if (!key) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set')

  const url = rawUrl.replace(/\/rest\/v1\/?$/, '')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _client = createClient<any>(url, key)
  return _client
}
