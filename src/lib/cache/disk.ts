import fs from 'fs'
import path from 'path'

// In Vercel serverless the only writable path is /tmp (ephemeral per warm instance).
// In local dev, use .cache/ at the project root (gitignored).
const CACHE_DIR = process.env.VERCEL
  ? path.join('/tmp', 'etherscan-cache')
  : path.join(process.cwd(), '.cache', 'etherscan')

export interface DiskEntry<T> {
  fetchedAt: number // Unix ms
  lastBlock: number // highest block included; 0 if not applicable
  data: T
}

// In-memory L1 cache — fast within a single Node.js process lifetime
const mem = new Map<string, DiskEntry<unknown>>()

/** Read from cache if not older than maxAgeMs. Checks memory then disk. */
export function diskCacheRead<T>(
  key: string,
  maxAgeMs: number
): DiskEntry<T> | null {
  const cached = mem.get(key) as DiskEntry<T> | undefined
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) return cached

  const entry = readFromDisk<T>(key)
  if (entry && Date.now() - entry.fetchedAt < maxAgeMs) {
    mem.set(key, entry as DiskEntry<unknown>)
    return entry
  }
  return null
}

/** Read from cache regardless of age. Used for incremental block-range updates. */
export function diskCacheReadStale<T>(key: string): DiskEntry<T> | null {
  const cached = mem.get(key) as DiskEntry<T> | undefined
  if (cached) return cached
  return readFromDisk<T>(key)
}

/** Write to memory and disk. Disk failures are non-fatal. */
export function diskCacheWrite<T>(key: string, entry: DiskEntry<T>): void {
  mem.set(key, entry as DiskEntry<unknown>)
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(CACHE_DIR, `${sanitize(key)}.json`),
      JSON.stringify(entry),
      'utf-8'
    )
  } catch (err) {
    console.warn('[disk-cache] write failed for', key, '—', err)
  }
}

/** Delete every entry from memory and disk. */
export function diskCacheClearAll(): void {
  mem.clear()
  try {
    const files = fs.readdirSync(CACHE_DIR)
    for (const f of files) {
      try { fs.unlinkSync(path.join(CACHE_DIR, f)) } catch { /* ignore */ }
    }
  } catch { /* directory may not exist */ }
}

function readFromDisk<T>(key: string): DiskEntry<T> | null {
  try {
    const raw = fs.readFileSync(
      path.join(CACHE_DIR, `${sanitize(key)}.json`),
      'utf-8'
    )
    return JSON.parse(raw) as DiskEntry<T>
  } catch {
    return null
  }
}

function sanitize(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()
}
