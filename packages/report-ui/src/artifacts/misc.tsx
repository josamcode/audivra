/** @jsxRuntime automatic @jsxImportSource react */
import type { ArtifactDataMap } from '@audivra/contracts'
import { clsx } from 'clsx'
import { RefChip, RefChips } from '../components/primitives.tsx'
import type { RenderContext } from '../types.ts'

export function TechMapView({ data, ctx }: { data: ArtifactDataMap['tech_map']; ctx: RenderContext }) {
  return (
    <dl className="av-techmap">
      {data.groups.map((group) => (
        <div key={group.label} className="av-tech-group">
          <dt dir="auto">{group.label}</dt>
          <dd>
            {group.items.map((item) => (
              <span
                key={item.name}
                className={clsx('av-chip', item.confidence < 0.6 && 'av-chip-weak')}
                title={`Confidence ${Math.round(item.confidence * 100)}%`}
              >
                <span dir="auto">{item.name}</span>
                <span className="av-chip-conf av-num">{Math.round(item.confidence * 100)}%</span>
                {item.evidenceId && ctx.mode === 'app' ? <RefChip value={item.evidenceId} kind="evidence" ctx={ctx} /> : null}
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const IMPACTS = ['high', 'medium', 'low'] as const
const EFFORTS = ['low', 'medium', 'high'] as const

/** Impact × effort grid. Placement only — no ROI numbers are implied. */
export function ImpactEffortView({ data, ctx }: { data: ArtifactDataMap['impact_effort']; ctx: RenderContext }) {
  return (
    <div className="av-impact">
      <div className="av-impact-grid" role="table" aria-label="Impact versus effort">
        <div className="av-impact-corner" role="columnheader" />
        {EFFORTS.map((effort) => (
          <div key={effort} className="av-impact-colhead" role="columnheader">
            {effort.charAt(0).toUpperCase() + effort.slice(1)} effort
          </div>
        ))}
        {IMPACTS.map((impact) => (
          <div key={impact} className="av-impact-row" role="row">
            <div className="av-impact-rowhead" role="rowheader">
              {impact.charAt(0).toUpperCase() + impact.slice(1)} impact
            </div>
            {EFFORTS.map((effort) => {
              const items = data.items.filter((item) => item.impact === impact && item.effort === effort)
              const quickWin = impact === 'high' && effort === 'low'
              return (
                <div
                  key={effort}
                  role="cell"
                  className={clsx('av-impact-cell', quickWin && 'av-quick-win', !items.length && 'av-impact-empty')}
                >
                  {quickWin ? <span className="av-impact-tag">Quick wins</span> : null}
                  {items.map((item, index) => (
                    <div key={`${item.label}-${index}`} className="av-impact-item">
                      <span dir="auto">{item.label}</span>
                      {item.findingIds.length ? <RefChips refs={item.findingIds} kind="finding" ctx={ctx} /> : null}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
