import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useMediaQuery } from '@/lib/hooks'
import { IMAGES, type LandingImage } from './images'
import { Eyebrow, Shot } from './primitives'

interface Stage {
  id: string
  step: string
  title: string
  body: string[]
  image: LandingImage
  tone: 'violet' | 'blue' | 'mixed'
  secondary: ReactNode
}

const STAGES: Stage[] = [
  {
    id: 'scanner',
    step: 'Stage 1',
    title: 'Automated scanning',
    body: [
      'A deterministic baseline runs first: a bounded crawl, Lighthouse on mobile, axe-core and Pa11y accessibility checks, link checking, HTTP headers and TLS, robots and sitemaps, SEO metadata and structured data.',
      'A real browser opens your pages at desktop and mobile sizes to capture screenshots, console errors, failed requests and overflow. Every check lands in a coverage table — ran, partial, skipped or unavailable — with the reason.',
    ],
    image: IMAGES.stageScanner,
    tone: 'violet',
    secondary: (
      <Link to="/system" className="lp-btn lp-btn--outline">
        Check tool readiness
      </Link>
    ),
  },
  {
    id: 'ai-auditor',
    step: 'Stage 2',
    title: 'AI Auditor',
    body: [
      'An autonomous auditor first works out the business: what the site offers, who it serves and what its primary conversion should be. Then it decides what deserves a closer look.',
      'It drives a real browser, runs audit tools and writes small scripts when they help — spending effort where importance and uncertainty are highest, and recording evidence for every important claim.',
    ],
    image: IMAGES.stageAuditor,
    tone: 'mixed',
    secondary: (
      <a href="#evidence" className="lp-btn lp-btn--outline">
        How evidence works
      </a>
    ),
  },
  {
    id: 'ai-reviewer',
    step: 'Stage 3',
    title: 'AI Reviewer',
    body: [
      'A second AI pass reviews the draft adversarially. It challenges unsupported claims, inflated severities, duplicates, scanner noise and findings contradicted by browser evidence.',
      'The auditor then re-verifies what was challenged, and a final step orders the findings under strict rules: no invented findings, no new evidence and no severity escalation.',
    ],
    image: IMAGES.stageReviewer,
    tone: 'blue',
    secondary: (
      <Link to="/audits" className="lp-btn lp-btn--outline">
        Browse past audits
      </Link>
    ),
  },
]

function StageShot({ stage }: { stage: Stage }) {
  return (
    <div className="lp-shot" data-tone={stage.tone}>
      <Shot
        image={stage.image}
        className="lp-shot__img"
        sizes="(min-width: 1025px) 46vw, (min-width: 768px) calc(100vw - 104px), calc(100vw - 80px)"
      />
    </div>
  )
}

/**
 * Desktop: the stage nearest the reading line is active and the sticky visual crossfades to its screenshot
 * (the reference's solution grid). Smaller screens show every stage with its own screenshot instead.
 */
function useActiveStage(items: RefObject<(HTMLElement | null)[]>, enabled: boolean): number {
  const [active, setActive] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let frame = 0
    const update = () => {
      frame = 0
      const line = window.innerHeight * 0.55
      let next = 0
      items.current.forEach((item, index) => {
        if (item && item.getBoundingClientRect().top <= line) next = index
      })
      setActive(next)
    }
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      window.cancelAnimationFrame(frame)
    }
  }, [items, enabled])
  return active
}

export function Stages() {
  const desktop = useMediaQuery('(min-width: 1025px)')
  const items = useRef<(HTMLElement | null)[]>([])
  const active = useActiveStage(items, desktop)

  return (
    <section id="how-it-works" className="lp-stages" aria-labelledby="lp-stages-title">
      <div className="lp-wrap">
        <div className="lp-stages__intro">
          <Eyebrow>How it works</Eyebrow>
          <h2 id="lp-stages-title" className="lp-h2">
            Most website checkers list problems.
            <br />
            <span className="lp-gradient-text">Audivra investigates which ones matter.</span>
          </h2>
        </div>

        <div className="lp-stages__grid">
          <ol className="lp-stages__list">
            {STAGES.map((stage, index) => (
              <li
                key={stage.id}
                id={stage.id}
                ref={(node) => {
                  items.current[index] = node
                }}
                className="lp-stage"
                data-active={desktop ? index === active : undefined}
              >
                <span className="lp-stage__step">{stage.step}</span>
                <h3 className="lp-h3">{stage.title}</h3>
                {stage.body.map((paragraph) => (
                  <p key={paragraph.slice(0, 24)}>{paragraph}</p>
                ))}
                <div className="lp-stage__media">
                  <StageShot stage={stage} />
                </div>
                <div className="lp-stage__actions">
                  <Link to="/audits/new" className="lp-btn lp-btn--primary">
                    Audit your website
                  </Link>
                  {stage.secondary}
                </div>
              </li>
            ))}
          </ol>

          <div className="lp-stages__visual" aria-hidden>
            {STAGES.map((stage, index) => (
              <div key={stage.id} data-active={index === active}>
                <StageShot stage={stage} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
