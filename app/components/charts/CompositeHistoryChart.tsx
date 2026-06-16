'use client'

import type { ReactNode } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
} from 'recharts'

interface HistoryPoint {
  day: string
  composite: number
}

interface CompositeHistoryChartProps {
  data: HistoryPoint[]
}

function fmtMonthYear(label: ReactNode): string {
  if (label == null) return ''
  const str = String(label)
  const d = new Date(str + 'T00:00:00Z')
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

export function CompositeHistoryChart({ data }: CompositeHistoryChartProps) {
  if (data.length === 0) return <div className="h-72 bg-zinc-50 rounded" />

  return (
    <ResponsiveContainer width="100%" height={288}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" vertical={false} />
        <XAxis
          dataKey="day"
          tickFormatter={fmtMonthYear}
          tick={{ fontSize: 11, fill: '#a1a1aa' }}
          tickLine={false}
          axisLine={{ stroke: '#e4e4e7' }}
          minTickGap={32}
        />
        <YAxis
          domain={[0, 100]}
          ticks={[0, 25, 50, 75, 100]}
          tick={{ fontSize: 11, fill: '#a1a1aa' }}
          tickLine={false}
          axisLine={false}
          width={32}
        />
        {/* 50 = flat adoption */}
        <ReferenceLine y={50} stroke="#d4d4d8" strokeDasharray="4 4" />
        <Line
          type="monotone"
          dataKey="composite"
          stroke="#1d4ed8"
          strokeWidth={1.75}
          dot={false}
          isAnimationActive={false}
        />
        <Tooltip
          contentStyle={{
            fontSize: 11,
            padding: '4px 8px',
            border: '1px solid #e4e4e7',
            borderRadius: 4,
            backgroundColor: '#fff',
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter={(v: any) => [typeof v === 'number' ? v.toFixed(1) : v, 'Composite']}
          labelFormatter={fmtMonthYear}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
