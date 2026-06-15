/**
 * Shared factor metadata + formatting for the index UI.
 *
 * Schema-flexible by design: the index `factors` object may gain, lose, or
 * rename keys across methodology versions (e.g. the planned 3-month → 1-month
 * window change turns `aumGrowth3m` into `aumGrowth1m`, and v2.0 may add or
 * audit factors). UI that renders factors should iterate over whatever keys are
 * actually present in a reading and look each up here, falling back to a derived
 * label when a key is unknown — so a renamed/added factor still renders rather
 * than disappearing or throwing.
 */

export interface FactorMeta {
  label: string
  sublabel: string
  weight: number
  /** How to render the raw input value for this factor. */
  rawKind: 'pct' | 'pp' | 'ratio' | 'count'
}

/**
 * Known factors, keyed by the `factors` JSON key. When the methodology window
 * or factor set changes, add the new keys here; old keys can stay so historical
 * readings (which keep their original keys) continue to render with proper
 * labels.
 */
export const FACTOR_META: Record<string, FactorMeta> = {
  // ── v1.x (3-month window) ──────────────────────────────────────────────
  aumGrowth3m: { label: 'AUM Growth', sublabel: '3-month', weight: 0.25, rawKind: 'pct' },
  holderGrowth3m: { label: 'Holder Growth', sublabel: '3-month', weight: 0.2, rawKind: 'pct' },
  concentrationDelta3m: { label: 'Concentration', sublabel: '3-month trend', weight: 0.2, rawKind: 'pp' },
  dormancyDelta3m: { label: 'Dormancy', sublabel: '3-month trend', weight: 0.15, rawKind: 'pp' },
  transferActivityRatio: { label: 'Transfer Activity', sublabel: '30d vs 3m avg', weight: 0.1, rawKind: 'ratio' },
  breadth: { label: 'Breadth', sublabel: 'products + chains', weight: 0.1, rawKind: 'count' },

  // ── Forward-compatibility: 1-month window keys (planned). Weights are
  //    placeholders mirroring current weights; update when recalibration lands.
  aumGrowth1m: { label: 'AUM Growth', sublabel: '1-month', weight: 0.25, rawKind: 'pct' },
  holderGrowth1m: { label: 'Holder Growth', sublabel: '1-month', weight: 0.2, rawKind: 'pct' },
  concentrationDelta1m: { label: 'Concentration', sublabel: '1-month trend', weight: 0.2, rawKind: 'pp' },
  dormancyDelta1m: { label: 'Dormancy', sublabel: '1-month trend', weight: 0.15, rawKind: 'pp' },
}

/** Stable display order; keys not listed sort after, alphabetically. */
const ORDER = [
  'aumGrowth3m', 'aumGrowth1m',
  'holderGrowth3m', 'holderGrowth1m',
  'concentrationDelta3m', 'concentrationDelta1m',
  'dormancyDelta3m', 'dormancyDelta1m',
  'transferActivityRatio',
  'breadth',
]

/** Derive a readable label for an unknown factor key as a last resort. */
export function deriveLabel(key: string): string {
  const spaced = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/(\d+m)$/i, ' $1')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function metaFor(key: string): FactorMeta {
  return FACTOR_META[key] ?? { label: deriveLabel(key), sublabel: '', weight: 0, rawKind: 'count' }
}

/** Order a set of factor keys for display. */
export function orderFactorKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ia = ORDER.indexOf(a)
    const ib = ORDER.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
}

export function fmtFactorRaw(key: string, raw: number): string {
  const kind = metaFor(key).rawKind
  switch (kind) {
    case 'pct':
      return raw >= 0 ? `+${(raw * 100).toFixed(1)}%` : `${(raw * 100).toFixed(1)}%`
    case 'pp':
      return raw >= 0 ? `+${(raw * 100).toFixed(1)}pp` : `${(raw * 100).toFixed(1)}pp`
    case 'ratio':
      return `×${raw.toFixed(2)}`
    case 'count':
      return `${Math.round(raw)}`
  }
}
