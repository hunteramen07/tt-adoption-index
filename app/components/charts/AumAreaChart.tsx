'use client'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

interface AumPoint {
  day: string
  totalAum: number
}

interface AumAreaChartProps {
  data: AumPoint[]
}

function fmtYAxis(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`
  return `$${n.toFixed(0)}`
}

function fmtTooltipAum(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  return `$${n.toFixed(0)}`
}

// Show quarterly ticks on x-axis to avoid crowding
function pickXTicks(data: AumPoint[]): string[] {
  if (data.length === 0) return []
  const ticks: string[] = []
  for (const p of data) {
    const [, mm] = p.day.split('-')
    if (mm === '01' || mm === '04' || mm === '07' || mm === '10') {
      ticks.push(p.day)
    }
  }
  return ticks
}

export function AumAreaChart({ data }: AumAreaChartProps) {
  if (data.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-zinc-400 text-sm">
        No data
      </div>
    )
  }

  const xTicks = pickXTicks(data)

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="aumGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#1d4ed8" stopOpacity={0.12} />
            <stop offset="95%" stopColor="#1d4ed8" stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" vertical={false} />
        <XAxis
          dataKey="day"
          ticks={xTicks}
          tick={{ fontSize: 11, fill: '#71717a' }}
          tickLine={false}
          axisLine={{ stroke: '#e4e4e7' }}
          tickFormatter={(d: string) =>
            new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', {
              month: 'short',
              year: '2-digit',
            })
          }
        />
        <YAxis
          tickFormatter={fmtYAxis}
          tick={{ fontSize: 11, fill: '#71717a' }}
          tickLine={false}
          axisLine={false}
          width={58}
        />
        <Tooltip
          contentStyle={{
            fontSize: 12,
            padding: '6px 10px',
            border: '1px solid #e4e4e7',
            borderRadius: 4,
            backgroundColor: '#fff',
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter={(v: any) => [typeof v === 'number' ? fmtTooltipAum(v) : v, 'Total AUM']}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          labelFormatter={(label: any) => {
            if (typeof label !== 'string') return label
            return new Date(label + 'T00:00:00Z').toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
          }}
        />
        <Area
          type="monotone"
          dataKey="totalAum"
          stroke="#1d4ed8"
          strokeWidth={1.5}
          fill="url(#aumGrad)"
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
