/*
 * Product imagery for the landing page. Every image is a screenshot of the real app showing a real,
 * completed audit of books.toscrape.com (a public demo store built for scraping practice) or, for the
 * comparison, the bundled fixture site's audit history. Regenerate them from the running app rather
 * than editing them by hand.
 */
import cardExport1x from './assets/card-export-236.webp'
import cardExport2x from './assets/card-export-472.webp'
import cardHistory2x from './assets/card-history-1520.webp'
import cardHistory1x from './assets/card-history-760.webp'
import cardReport2x from './assets/card-report-1520.webp'
import cardReport1x from './assets/card-report-760.webp'
import evidenceFinding2x from './assets/evidence-finding-1344.webp'
import evidenceFinding1x from './assets/evidence-finding-672.webp'
import stageAuditor2x from './assets/stage-auditor-1640.webp'
import stageAuditor1x from './assets/stage-auditor-820.webp'
import stageReviewer2x from './assets/stage-reviewer-1640.webp'
import stageReviewer1x from './assets/stage-reviewer-820.webp'
import stageScanner2x from './assets/stage-scanner-1640.webp'
import stageScanner1x from './assets/stage-scanner-820.webp'
import tourEvidence2x from './assets/tour-evidence-1600.webp'
import tourEvidence1x from './assets/tour-evidence-800.webp'
import tourFindings2x from './assets/tour-findings-1600.webp'
import tourFindings1x from './assets/tour-findings-800.webp'
import tourOverview2x from './assets/tour-overview-1600.webp'
import tourOverview1x from './assets/tour-overview-800.webp'
import tourReport2x from './assets/tour-report-1600.webp'
import tourReport1x from './assets/tour-report-800.webp'

export interface LandingImage {
  /** 1x source and its intrinsic size; the 2x source is exactly double. */
  src: string
  src2x: string
  width: number
  height: number
  alt: string
}

const image = (src: string, src2x: string, width: number, height: number, alt: string): LandingImage => ({
  src,
  src2x,
  width,
  height,
  alt,
})

export const IMAGES = {
  tourOverview: image(
    tourOverview1x,
    tourOverview2x,
    800,
    500,
    'Audivra audit overview for books.toscrape.com: 15 findings, all verified, 30 pages, 49 pieces of evidence and an executive take',
  ),
  tourFindings: image(
    tourFindings1x,
    tourFindings2x,
    800,
    500,
    'Findings table with severity, category, affected page, reviewer verification, confidence and evidence count',
  ),
  tourEvidence: image(
    tourEvidence1x,
    tourEvidence2x,
    800,
    500,
    'A finding opened in its drawer: problem, what was observed, reviewer approval and the linked evidence screenshot',
  ),
  tourReport: image(
    tourReport1x,
    tourReport2x,
    800,
    500,
    'Client view of the report: executive snapshot, findings by severity, scope and key metrics',
  ),
  stageScanner: image(
    stageScanner1x,
    stageScanner2x,
    820,
    520,
    'Baseline evidence list: HTTP headers, TLS, robots and sitemap, crawl, SEO metadata, Lighthouse and screenshots',
  ),
  stageAuditor: image(
    stageAuditor1x,
    stageAuditor2x,
    820,
    520,
    'The AI auditor’s executive take, describing what the site is and how it was assessed, above the findings that matter most',
  ),
  stageReviewer: image(
    stageReviewer1x,
    stageReviewer2x,
    820,
    520,
    'Findings marked Verified with the reviewer’s verdict (approved or revised) and a confidence score for each',
  ),
  evidenceFinding: image(
    evidenceFinding1x,
    evidenceFinding2x,
    672,
    1000,
    'A verified medium-severity mobile finding with 98% confidence, reviewer approved, citing three pieces of evidence including the mobile screenshot',
  ),
  cardReport: image(
    cardReport1x,
    cardReport2x,
    760,
    760,
    'Client-ready report with prepared-for details, an executive snapshot, findings by severity and scope',
  ),
  cardHistory: image(
    cardHistory1x,
    cardHistory2x,
    760,
    760,
    'Comparison with the previous audit: counts of regressed, new and improved findings and a list of finding changes',
  ),
  cardExport: image(
    cardExport1x,
    cardExport2x,
    236,
    490,
    'Export menu: client report as PDF or HTML, audit data as JSON, findings, pages and performance as CSV, and a ZIP bundle',
  ),
} satisfies Record<string, LandingImage>
