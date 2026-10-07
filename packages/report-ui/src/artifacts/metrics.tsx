/** @jsxRuntime automatic @jsxImportSource react */
import type { ArtifactDataMap, Datum } from '@audivra/contracts'
import { clsx } from 'clsx'
import { formatDatum } from '../format.ts'

/** Compact stat tile: label, value in its unit, optional note. Deliberately small (no KPI walls). */
export function StatTile({ datum, size = 'md' }: { datum: Datum; size?: 'md' | 'lg' }) {
  const tone = datum.tone ?? 'neutral'
  return (
    <div className={clsx('av-stat', size === 'lg' && 'av-stat-lg')}>
      <div className="av-stat-label" dir="auto">
        {datum.label}
      </div>
      <div className={clsx('av-stat-value av-num', `av-tone-${tone}`)}>{formatDatum(datum)}</div>
      {datum.note ? (
        <div className="av-stat-note" dir="auto">
          {datum.note}
        </div>
      ) : null}
    </div>
  )
}

export function MetricView({ data }: { data: ArtifactDataMap['metric'] }) {
  return (
    <div className="av-metric">
      <StatTile datum={data.item} size="lg" />
      {data.caption ? (
        <p className="av-metric-caption" dir="auto">
          {data.caption}
        </p>
      ) : null}
    </div>
  )
}

export function MetricGroupView({ data }: { data: ArtifactDataMap['metric_group'] }) {
  return (
    <div className="av-stat-grid">
      {data.items.map((item, index) => (
        <StatTile key={`${item.label}-${index}`} datum={item} />
      ))}
    </div>
  )
}
