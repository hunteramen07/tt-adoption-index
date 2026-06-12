'use client'

import { useState } from 'react'

const OPTIONS = [1, 3, 5, 10] as const
type N = (typeof OPTIONS)[number]

interface Props {
  /** Percentage share of each top holder, sorted descending (e.g. [23.5, 18.2, …]). */
  shares: number[]
  defaultN?: N
  /** Compact variant for table cells; full variant for stat cards. */
  compact?: boolean
}

export function TopNSelector({ shares, defaultN = 5, compact = false }: Props) {
  const [n, setN] = useState<N>(defaultN)
  const value = shares.slice(0, Math.min(n, shares.length)).reduce((s, v) => s + v, 0)
  const display = shares.length > 0 ? `${value.toFixed(1)}%` : '—'

  const buttons = OPTIONS.map((opt) => (
    <button
      key={opt}
      onClick={() => setN(opt)}
      className={
        compact
          ? `text-[9px] px-1 py-px rounded leading-none ${
              n === opt ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-600'
            }`
          : `text-[10px] px-1.5 py-0.5 rounded ${
              n === opt
                ? 'bg-zinc-800 text-white font-semibold'
                : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
            }`
      }
    >
      {opt}
    </button>
  ))

  if (compact) {
    return (
      <div className="text-right">
        <span className="font-mono tabular-nums text-zinc-700">{display}</span>
        <div className="flex justify-end gap-0.5 mt-0.5">{buttons}</div>
      </div>
    )
  }

  return (
    <>
      <p className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-zinc-900">
        {display}
      </p>
      <div className="flex gap-1 mt-1.5">{buttons}</div>
    </>
  )
}
