import { BadgeCheck, Gauge, Link2, Lock, Monitor, Scale, type LucideIcon } from 'lucide-react'
import { IMAGES } from './images'
import { Eyebrow, Shot, useSvgId } from './primitives'

const MEASURED: { icon: LucideIcon; text: string }[] = [
  { icon: Monitor, text: 'A real browser at desktop and mobile sizes' },
  { icon: Gauge, text: 'Lighthouse, axe-core and Pa11y results' },
  { icon: Lock, text: 'Headers, TLS, links, robots and sitemaps' },
]

const CONCLUDED: { icon: LucideIcon; text: string }[] = [
  { icon: Scale, text: 'Severity weighed against business impact' },
  { icon: Link2, text: 'Every claim linked to recorded evidence' },
  { icon: BadgeCheck, text: 'Challenged by an independent AI reviewer' },
]

function Connector() {
  const gradient = useSvgId('lp-connector')
  return (
    <div className="lp-diagram__connector" aria-hidden>
      <svg viewBox="0 0 72 24" fill="none">
        <defs>
          <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="0" y1="12" x2="72" y2="12">
            <stop offset="0" stopColor="#206fed" stopOpacity="0.25" />
            <stop offset="1" stopColor="#5b24c7" />
          </linearGradient>
        </defs>
        <path
          d="M2 12h62"
          stroke={`url(#${gradient})`}
          strokeWidth="2.5"
          strokeDasharray="7 5"
          strokeLinecap="round"
        />
        <path
          d="m58 5 8 7-8 7"
          stroke="#5b24c7"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

function Column({
  side,
  label,
  lead,
  items,
  note,
}: {
  side: 'in' | 'out'
  label: string
  lead: string
  items: { icon: LucideIcon; text: string }[]
  note: string
}) {
  return (
    <div className="lp-diagram__col" data-side={side}>
      <h3 className="lp-diagram__label">{label}</h3>
      <p className="lp-diagram__lead">{lead}</p>
      <ul className="lp-diagram__list">
        {items.map(({ icon: Icon, text }) => (
          <li key={text}>
            <span className="lp-diagram__icon">
              <Icon aria-hidden />
            </span>
            {text}
          </li>
        ))}
      </ul>
      <p className="lp-diagram__note">{note}</p>
    </div>
  )
}

export function EvidenceSection() {
  return (
    <section id="evidence" className="lp-platform" aria-labelledby="lp-evidence-title">
      <div className="lp-wrap">
        <div className="lp-section-heading">
          <Eyebrow>Why Audivra</Eyebrow>
          <h2 id="lp-evidence-title" className="lp-h2">
            Not another checklist.
            <br />
            <span className="lp-gradient-text">Evidence you can open.</span>
          </h2>
          <p>
            Automated checks are where an Audivra audit starts, not where it ends. Baseline facts are treated
            as leads, and a finding is only reported together with the evidence behind it.
          </p>
        </div>

        <div className="lp-diagram">
          <div className="lp-diagram__panel">
            <Column
              side="in"
              label="Measured"
              lead="Facts from the baseline, treated as leads."
              items={MEASURED}
              note="Deterministic and repeatable, with coverage reported for every check."
            />
            <Connector />
            <figure className="lp-diagram__center">
              <div className="lp-diagram__ring">
                <Shot image={IMAGES.evidenceFinding} sizes="(max-width: 440px) calc(100vw - 80px), 360px" />
              </div>
              <figcaption className="lp-diagram__caption">
                A real finding from an audit of books.toscrape.com, a public demo store built for scraping
                practice.
              </figcaption>
            </figure>
            <Connector />
            <Column
              side="out"
              label="Concluded"
              lead="Findings you can act on."
              items={CONCLUDED}
              note="Built to reduce false positives, with a confidence score on every finding."
            />
          </div>
        </div>
      </div>
    </section>
  )
}
