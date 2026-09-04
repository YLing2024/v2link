import { useMemo } from 'react'
import { DOWN_COLOR, UP_COLOR, chartGeom } from '../lib/trafficChart'
import type { TrafficPoint } from '../types'

// 流量折线（轻量 SVG）：下行实线 + 浅面积、上行浅线；右下角标注当前桶峰值。
// 固定逻辑尺寸 640×110，viewBox 等比缩放，无重库依赖。

export default function TrafficChart({ points }: { points: TrafficPoint[] }) {
  const { max, down, up, area } = useMemo(() => chartGeom(points), [points])
  if (!down) return null
  return (
    <div className="traffic-chart">
      <svg
        viewBox={`0 0 640 110`}
        className="traffic-chart-svg"
        role="img"
        aria-label="流量趋势"
      >
        {area && <path d={area} fill={DOWN_COLOR} opacity={0.06} />}
        <path d={down} fill="none" stroke={DOWN_COLOR} strokeWidth={1.6} strokeLinejoin="round" />
        {up && <path d={up} fill="none" stroke={UP_COLOR} strokeWidth={1.2} strokeLinejoin="round" />}
      </svg>
      {max > 0 && <span className="chart-peak">峰值 ↓ {formatChart(max)}</span>}
    </div>
  )
}

function formatChart(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}
