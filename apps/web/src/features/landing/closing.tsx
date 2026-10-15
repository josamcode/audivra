import { Link } from '@tanstack/react-router'
import { ArrowRight, ChevronDown } from 'lucide-react'
import { useId, useState } from 'react'

const FAQ: { question: string; answer: string }[] = [
  {
    question: 'What does an Audivra audit check?',
    answer:
      'A deterministic baseline covers performance (Lighthouse on mobile), accessibility (axe-core and Pa11y), SEO metadata and structured data, links, HTTP headers and TLS, robots and sitemaps, and real-browser behaviour at desktop and mobile sizes. The AI auditor then investigates what matters for the business: journeys, conversion, content, trust and technical issues.',
  },
  {
    question: 'How long does an audit take?',
    answer:
      'A full AI audit usually takes roughly 10 to 25 minutes, depending on the site. You can follow every stage live while it runs.',
  },
  {
    question: 'Will Audivra change anything on my website?',
    answer:
      'No. The checks are passive: no forms are submitted, nothing is purchased and no active security scanning is run.',
  },
  {
    question: 'Where does the AI run?',
    answer:
      'Through your own logged-in Claude Code CLI, so there is no API key or separate API billing to set up. With the AI turned off, Audivra still runs the full deterministic baseline.',
  },
  {
    question: 'What do I get at the end?',
    answer:
      'Findings with severity, confidence, the reviewer’s verdict and the evidence behind them; an executive summary; a client-ready report with exports; and, when the site was audited before, a comparison with the previous audit.',
  },
]

function Faq() {
  const [open, setOpen] = useState<number | null>(0)
  const id = useId()
  return (
    <ul className="lp-faq">
      {FAQ.map((item, index) => {
        const expanded = open === index
        return (
          <li key={item.question} className="lp-faq__item" data-open={expanded}>
            <h3>
              <button
                type="button"
                className="lp-faq__btn"
                aria-expanded={expanded}
                aria-controls={`${id}-${index}`}
                onClick={() => setOpen(expanded ? null : index)}
              >
                {item.question}
                <ChevronDown aria-hidden />
              </button>
            </h3>
            <div id={`${id}-${index}`} className="lp-faq__panel" aria-hidden={!expanded}>
              <div>
                <p>{item.answer}</p>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function Closing() {
  return (
    <section id="faq" className="lp-demo" aria-labelledby="lp-closing-title">
      <div className="lp-wrap lp-demo__grid">
        <div className="lp-demo__copy">
          <h2 id="lp-closing-title">See your website more clearly.</h2>
          <p>
            Understand what’s working, discover what needs attention, and make improvements based on real
            evidence.
          </p>
          <Link to="/audits/new" className="lp-btn lp-btn--primary">
            Start your audit
            <ArrowRight aria-hidden />
          </Link>
        </div>
        <Faq />
      </div>
    </section>
  )
}
