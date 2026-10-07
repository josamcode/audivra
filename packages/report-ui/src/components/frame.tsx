/** @jsxRuntime automatic @jsxImportSource react */
import type { Artifact } from '@audivra/contracts'
import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import type { RenderContext } from '../types.ts'
import { RefChips } from './primitives.tsx'

/**
 * The one frame every artifact renders in: title, optional subtitle, the question it answers,
 * the visual, a short description and the evidence/finding references it rests on.
 */
export function ArtifactFrame({
  artifact,
  ctx,
  bare,
  actions,
  className,
  children,
}: {
  artifact: Artifact
  ctx: RenderContext
  bare?: boolean
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  const showActions = ctx.mode === 'app' && actions !== undefined && actions !== null
  const evidence = artifact.evidenceIds
  const findings = artifact.findingIds
  return (
    <figure
      className={clsx('av-frame', `av-type-${artifact.type}`, className)}
      data-artifact={artifact.ref}
      aria-label={artifact.title}
    >
      {bare ? null : (
        <header className="av-head">
          <div className={clsx('av-title-row', showActions && 'av-title-row-actions')}>
            <h3 className="av-title" dir="auto">
              {artifact.title}
            </h3>
            {ctx.mode === 'app' ? <span className="av-ref">{artifact.ref}</span> : null}
            {showActions ? <div className="av-actions">{actions}</div> : null}
          </div>
          {artifact.subtitle ? (
            <p className="av-subtitle" dir="auto">
              {artifact.subtitle}
            </p>
          ) : null}
          {artifact.question ? <p className="av-question">{artifact.question}</p> : null}
        </header>
      )}
      <div className="av-body">{children}</div>
      {artifact.description ? (
        <figcaption className="av-desc" dir="auto">
          {artifact.description}
        </figcaption>
      ) : null}
      {evidence.length || findings.length ? (
        <footer className="av-refs">
          {evidence.length ? (
            <span className="av-refs-group">
              <span className="av-refs-label">{ctx.mode === 'report' ? 'Sources' : 'Evidence'}</span>
              <RefChips refs={evidence} kind="evidence" ctx={ctx} />
            </span>
          ) : null}
          {findings.length ? (
            <span className="av-refs-group">
              <span className="av-refs-label">Findings</span>
              <RefChips refs={findings} kind="finding" ctx={ctx} />
            </span>
          ) : null}
        </footer>
      ) : null}
    </figure>
  )
}

export function EmptyVisual({ children }: { children: ReactNode }) {
  return <p className="av-empty">{children}</p>
}
