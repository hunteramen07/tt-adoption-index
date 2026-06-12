'use client'

import { AreaChart, Area, ResponsiveContainer, Tooltip } from 'recharts'

interface SparklinePoint {
  day: string
  composite: number
}

interface SparklineProps {
  data: SparklinePoint[]
}

export function Sparkline({ data }: SparklineProps) {
  if (data.length === 0) return <div className="h-14 bg-zinc-50 rounded" />

  return (
    <ResponsiveContainer width="100%" height={56}>
      <AreaChart
        data={data}
        margin={{ top: 2, right: 2, left: 2, bottom: 2 }}
      >
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#1d4ed8" stopOpacity={0.18} />
            <stop offset="95%" stopColor="#1d4ed8" stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="composite"
          stroke="#1d4ed8"
          strokeWidth={1.5}
          fill="url(#sparkFill)"
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
          formatter={(v: any) => [typeof v === 'number' ? v.toFixed(1) : v, 'Score']}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          labelFormatter={(label: any) => {
            if (typeof label !== 'string') return label
            const d = new Date(label + 'T00:00:00Z')
            return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
