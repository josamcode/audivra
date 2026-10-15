import { IMAGES, type LandingImage } from './images'
import { Eyebrow, Shot } from './primitives'

const CARDS: {
  tag: string
  title: string
  text: string
  image: LandingImage
  tone: 'violet' | 'blue' | 'mixed'
  variant?: 'menu'
}[] = [
  {
    tag: 'Report',
    title: 'A report your client can read',
    text: 'A snapshot, the top risks, proof for every finding and an action plan — the same report in the app, as standalone HTML and as a PDF, without run IDs or debug data.',
    image: IMAGES.cardReport,
    tone: 'violet',
  },
  {
    tag: 'Compare',
    title: 'See what changed after a fix',
    text: 'Audit the site again and Audivra compares it with the previous audit: new, regressed, improved, still present and not found again. “Not found again” is never treated as fixed.',
    image: IMAGES.cardHistory,
    tone: 'blue',
  },
  {
    tag: 'Export',
    title: 'Take the data with you',
    text: 'Download the report as PDF or HTML, findings, pages and performance as CSV, the full audit as JSON, or everything as one ZIP bundle. Exports never re-run the AI.',
    image: IMAGES.cardExport,
    tone: 'mixed',
    variant: 'menu',
  },
]

export function Improvements() {
  return (
    <section id="after-the-audit" className="lp-resources" aria-labelledby="lp-improvements-title">
      <div className="lp-wrap">
        <div className="lp-resources__head">
          <div>
            <Eyebrow>After the audit</Eyebrow>
            <h2 id="lp-improvements-title" className="lp-h2">
              From findings to improvements
            </h2>
          </div>
          <p>
            Every audit ends with something you can use: a report to share, a comparison with the last audit
            of the site, and the underlying data.
          </p>
        </div>
        <ul className="lp-cards">
          {CARDS.map((card) => (
            <li key={card.tag} className="lp-card">
              <div
                className={
                  card.variant === 'menu'
                    ? 'lp-shot lp-shot--square lp-shot--menu'
                    : 'lp-shot lp-shot--square'
                }
                data-tone={card.tone}
              >
                <Shot
                  image={card.image}
                  className="lp-shot__img"
                  sizes={
                    card.variant === 'menu'
                      ? '(min-width: 768px) 16vw, 52vw'
                      : '(min-width: 768px) 36vw, 112vw'
                  }
                />
              </div>
              <span className="lp-card__tag">{card.tag}</span>
              <h3>{card.title}</h3>
              <p>{card.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
