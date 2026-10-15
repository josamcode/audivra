import '@fontsource-variable/ibm-plex-sans'
import './landing.css'

import { useEffect } from 'react'
import { Closing } from './closing'
import { EvidenceSection } from './evidence-section'
import { Hero } from './hero'
import { Improvements } from './improvements'
import { ProductTour } from './product-tour'
import { SiteFooter } from './site-footer'
import { SiteHeader } from './site-header'
import { Stages } from './stages'

/** Public landing page at `/`. It renders without the app chrome; the workspace lives under /audits. */
export function LandingPage() {
  useEffect(() => {
    const previous = document.title
    document.title = 'Audivra — AI website audits backed by evidence'
    return () => {
      document.title = previous
    }
  }, [])

  return (
    <div className="lp" id="top">
      <a className="lp-skip" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">
        <Hero />
        <ProductTour />
        <Stages />
        <EvidenceSection />
        <Improvements />
        <Closing />
      </main>
      <SiteFooter />
    </div>
  )
}
