import { Link } from '@tanstack/react-router'
import { ArrowUp } from 'lucide-react'
import { Logo } from './primitives'

export function SiteFooter() {
  return (
    <footer className="lp-footer">
      <div className="lp-wrap">
        <a href="#top" className="lp-footer__brand" aria-label="Audivra, back to top">
          <Logo />
        </a>
        <div className="lp-footer__nav">
          <section className="lp-footer__group" aria-labelledby="lp-footer-product">
            <h2 id="lp-footer-product">Product</h2>
            <ul>
              <li>
                <a href="#how-it-works">How it works</a>
              </li>
              <li>
                <a href="#evidence">Evidence</a>
              </li>
              <li>
                <a href="#after-the-audit">Reports and history</a>
              </li>
              <li>
                <a href="#faq">FAQ</a>
              </li>
            </ul>
          </section>
          <section className="lp-footer__group" aria-labelledby="lp-footer-workspace">
            <h2 id="lp-footer-workspace">Workspace</h2>
            <ul>
              <li>
                <Link to="/audits">Audits</Link>
              </li>
              <li>
                <Link to="/audits/new">New audit</Link>
              </li>
              <li>
                <Link to="/security">Security engagements</Link>
              </li>
              <li>
                <Link to="/system">System status</Link>
              </li>
            </ul>
          </section>
          <p className="lp-footer__about">
            Audivra is a local-first website auditing workstation: automated scanning, an AI auditor and an
            independent AI reviewer, with evidence behind every finding.
          </p>
        </div>
        <div className="lp-footer__legal">
          <p>© {new Date().getFullYear()} Audivra</p>
          <a href="#top">
            Back to top
            <ArrowUp aria-hidden />
          </a>
        </div>
      </div>
    </footer>
  )
}
