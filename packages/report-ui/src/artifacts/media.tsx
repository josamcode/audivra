/** @jsxRuntime automatic @jsxImportSource react */
import type { ArtifactDataMap } from '@audivra/contracts'
import type { CSSProperties } from 'react'
import { clsx } from 'clsx'
import { formatDate, shortUrl } from '../format.ts'
import { RefChip, SeverityPill } from '../components/primitives.tsx'
import type { RenderContext } from '../types.ts'

function MissingImage({ label }: { label: string }) {
  return <div className="av-image-missing">{label}</div>
}

export function EvidenceGalleryView({ data, ctx }: { data: ArtifactDataMap['evidence_gallery']; ctx: RenderContext }) {
  return (
    <div className="av-gallery">
      {data.items.map((item) => (
        <figure key={item.evidenceId} className="av-gallery-item">
          <div className="av-gallery-image">
            {item.imagePath ? (
              <img src={ctx.resolveAsset(item.imagePath)} alt={item.caption} loading="lazy" />
            ) : (
              <MissingImage label="Image unavailable" />
            )}
          </div>
          <figcaption>
            <span dir="auto">{item.caption}</span> <RefChip value={item.evidenceId} kind="evidence" ctx={ctx} />
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

/**
 * Screenshot with deterministic overlays. Regions are fractions of the image (0..1), so boxes stay
 * aligned at any display size; markers are listed with their explanation below the image.
 */
export function AnnotatedScreenshotView({
  data,
  ctx,
}: {
  data: ArtifactDataMap['annotated_screenshot']
  ctx: RenderContext
}) {
  const aspect = data.imageWidth && data.imageHeight ? data.imageHeight / data.imageWidth : null
  // Tall (mobile / full-page) captures are shown narrower so the annotated area stays readable.
  const maxWidth = aspect && aspect > 1.4 ? Math.round(Math.min(440, 640 / Math.min(aspect, 3))) : undefined
  // Portrait captures sit beside their legend when the frame is wide enough (container query in CSS).
  const portrait = maxWidth !== undefined
  return (
    <div
      className={clsx('av-annotated', portrait && 'av-annotated-portrait')}
      style={portrait ? ({ '--av-annot-w': `${maxWidth}px` } as CSSProperties) : undefined}
    >
      <div className="av-annot-layout">
      <div className="av-annot-stage" style={maxWidth ? { maxWidth } : undefined}>
        {data.imagePath ? (
          <img src={ctx.resolveAsset(data.imagePath)} alt="Annotated screenshot" className="av-annot-image" />
        ) : (
          <MissingImage label={`Screenshot ${data.evidenceId} unavailable`} />
        )}
        {data.imagePath
          ? data.regions.map((region, index) => (
              <div
                key={`${region.marker}-${index}`}
                className={clsx('av-annot-box', region.severity && `av-annot-${region.severity}`)}
                style={{
                  left: `${region.x * 100}%`,
                  top: `${region.y * 100}%`,
                  width: `${region.w * 100}%`,
                  height: `${region.h * 100}%`,
                }}
                aria-hidden
              >
                <span className="av-annot-marker">{region.marker}</span>
              </div>
            ))
          : null}
      </div>
      <ol className="av-annot-legend">
        {data.regions.map((region, index) => (
          <li key={`${region.marker}-${index}`}>
            <span className={clsx('av-annot-marker av-annot-marker-static', region.severity && `av-annot-${region.severity}`)}>
              {region.marker}
            </span>
            <div>
              <div className="av-annot-title">
                <span dir="auto">{region.title}</span>
                {region.severity ? <SeverityPill severity={region.severity} /> : null}
                {region.findingId ? <RefChip value={region.findingId} kind="finding" ctx={ctx} /> : null}
              </div>
              {region.description ? (
                <p className="av-annot-desc" dir="auto">
                  {region.description}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      </div>
    </div>
  )
}

export function BeforeAfterView({ data, ctx }: { data: ArtifactDataMap['before_after']; ctx: RenderContext }) {
  return (
    <div className="av-before-after">
      <div className="av-ba-meta">
        <span className="av-mono">{shortUrl(data.url, 60)}</span>
        <span className="av-muted-text">{data.viewport}</span>
      </div>
      <div className="av-ba-grid">
        {(['before', 'after'] as const).map((side) => {
          const shot = data[side]
          return (
            <figure key={side} className="av-ba-side">
              <figcaption>
                <span className="av-ba-label">{side === 'before' ? 'Before' : 'After'}</span>
                <span className="av-num av-muted-text">{formatDate(shot.date)}</span>
                <RefChip value={shot.evidenceId} kind="evidence" ctx={side === 'after' ? ctx : { ...ctx, onEvidenceClick: undefined }} />
              </figcaption>
              <div className="av-ba-image">
                <img src={ctx.resolveAsset(shot.imagePath, shot.auditId)} alt={`${side} screenshot`} loading="lazy" />
              </div>
            </figure>
          )
        })}
      </div>
      {data.caption ? (
        <p className="av-metric-caption" dir="auto">
          {data.caption}
        </p>
      ) : null}
    </div>
  )
}
