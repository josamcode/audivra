import { z } from 'zod'
import type { JourneyType } from './journeys.ts'

/**
 * Audit templates: mission context and priorities for the auditor. A template never turns an audit
 * into a checklist — it tells the auditor what matters most for this kind of site, and the auditor
 * still decides how to investigate and follows evidence beyond the focus.
 *
 * Templates are versioned product assets (like prompts). An audit records the key and version it used.
 */

export const TEMPLATE_KEYS = [
  'general',
  'lead-generation',
  'ecommerce',
  'saas',
  'portfolio',
  'bilingual',
  'technical',
] as const
export const AuditTemplateKey = z.enum(TEMPLATE_KEYS)
export type AuditTemplateKey = z.infer<typeof AuditTemplateKey>

export interface AuditTemplate {
  key: AuditTemplateKey
  /** Bumped whenever the guidance changes; stored with every audit that used it. */
  version: number
  name: string
  /** One line for the selector. */
  description: string
  /** Lucide icon name (rendered by the web app). */
  icon: string
  /** What this audit is for, in one or two sentences (shown in the audit and given to every role). */
  missionContext: string
  /** The few areas that deserve the most attention for this kind of site. */
  priorityAreas: string[]
  /** Journey types the auditor should look for first. */
  suggestedJourneyTypes: JourneyType[]
  /** Guidance appended to the auditor's task: priorities, never a checklist. */
  promptAddendum: string
}

export const DEFAULT_TEMPLATE_KEY: AuditTemplateKey = 'general'

export const AUDIT_TEMPLATES: readonly AuditTemplate[] = [
  {
    key: 'general',
    version: 1,
    name: 'General website',
    description: 'Balanced audit: the primary journey first, then what matters most for this site.',
    icon: 'Globe',
    missionContext: 'A balanced audit of how well the website serves its visitors and its business.',
    priorityAreas: [
      'The primary conversion journey',
      'Mobile experience',
      'Performance of the key page templates',
      'Indexability and SEO fundamentals',
      'Whether conversions can be measured',
    ],
    suggestedJourneyTypes: ['lead', 'contact', 'purchase', 'signup'],
    promptAddendum:
      'No specific focus was chosen. Work out what the site is for and let that decide your priorities: the primary conversion journey first, then the page types and issues that matter most for this business.',
  },
  {
    key: 'lead-generation',
    version: 1,
    name: 'Lead generation',
    description: 'Focus on forms, WhatsApp, calls, trust and conversion journeys.',
    icon: 'MessageSquare',
    missionContext: 'A lead-generation audit: how reliably the site turns visitors into enquiries, and whether those enquiries can be measured.',
    priorityAreas: [
      'Visibility of the primary call to action',
      'Forms and contact friction',
      'WhatsApp, phone and booking actions',
      'Trust built before the ask',
      'Conversion tracking of contact actions',
      'Landing and service pages',
      'The mobile conversion journey',
    ],
    suggestedJourneyTypes: ['lead', 'booking', 'contact'],
    promptAddendum:
      'This is a lead-generation audit. Pay particular attention to how visitors discover the value proposition, reach the primary contact action (form, WhatsApp, phone, booking), what stands in their way on mobile, whether trust is established before the ask, and whether those contact actions are measurable.',
  },
  {
    key: 'ecommerce',
    version: 1,
    name: 'E-commerce',
    description: 'Focus on product discovery, product pages, cart, checkout entry and purchase tracking.',
    icon: 'ShoppingCart',
    missionContext: 'An e-commerce audit: how easily shoppers find products, decide, and reach checkout — and whether purchases are measurable.',
    priorityAreas: [
      'Product discovery: navigation, search and categories',
      'Product page quality',
      'Cart and checkout entry',
      'Payment step entry (never submitted)',
      'Product structured data',
      'E-commerce tracking',
      'The mobile purchase journey',
    ],
    suggestedJourneyTypes: ['purchase', 'content-discovery'],
    promptAddendum:
      'This is an e-commerce audit. Pay particular attention to how shoppers find products (navigation, search, categories), whether product pages answer buying questions, how the cart and the entry to checkout behave on mobile, product structured data, and whether the purchase steps are measurable. Never enter payment details or place an order.',
  },
  {
    key: 'saas',
    version: 1,
    name: 'SaaS',
    description: 'Focus on value proposition, pricing, demo, sign-up and trial entry.',
    icon: 'AppWindow',
    missionContext: 'A SaaS audit: how quickly visitors understand the product, judge its price, and start a trial or demo — and whether those steps are measured.',
    priorityAreas: [
      'Clarity of the value proposition',
      'Pricing',
      'Demo, sign-up and trial entry',
      'Onboarding entry (no account creation)',
      'Trust and security signals',
      'Product analytics and conversion tracking',
    ],
    suggestedJourneyTypes: ['signup', 'demo'],
    promptAddendum:
      'This is a SaaS audit. Pay particular attention to how quickly visitors understand what the product does and for whom, how pricing is presented, how they reach sign-up, trial or demo (inspect the entry, never create an account), the trust and security signals around those steps, and whether they are tracked.',
  },
  {
    key: 'portfolio',
    version: 1,
    name: 'Portfolio / personal brand',
    description: 'Focus on positioning, case studies, credibility, social proof and the contact path.',
    icon: 'BriefcaseBusiness',
    missionContext: 'A portfolio audit: whether the site makes a credible case for the person or studio and makes it easy for a prospective client to get in touch.',
    priorityAreas: [
      'Clarity of positioning',
      'Case studies and proof of work',
      'Social proof',
      'The contact path',
      'Search visibility',
      'Measurement of enquiries',
    ],
    suggestedJourneyTypes: ['portfolio-contact', 'contact', 'content-discovery'],
    promptAddendum:
      'This is a portfolio / personal-brand audit. Pay particular attention to whether the positioning is clear (who this person or studio helps, and with what), how credible the work looks (case studies, outcomes, social proof), how easily a prospective client gets from the work to the contact action, and how discoverable the site is in search.',
  },
  {
    key: 'bilingual',
    version: 1,
    name: 'Arabic / bilingual',
    description: 'Focus on RTL/LTR, translation consistency, hreflang, language switching and localized journeys.',
    icon: 'Languages',
    missionContext: 'A bilingual audit: whether every language version — Arabic in particular — works as well as the others.',
    priorityAreas: [
      'RTL/LTR direction and mirroring',
      'Translation consistency and mixed-language UI',
      'Localized metadata and hreflang',
      'Language switching',
      'The primary journey in each language',
      'Arabic mobile layout',
      'Arabic page performance',
    ],
    suggestedJourneyTypes: ['lead', 'contact', 'purchase'],
    promptAddendum:
      'This is a bilingual (Arabic / English) audit. Compare the language versions: lang/dir and RTL mirroring, untranslated or mixed-language interface text, localized metadata and hreflang pairs, the language switcher, whether the primary journey works end to end in each language (Arabic on mobile in particular), and whether Arabic pages perform as well as the others.',
  },
  {
    key: 'technical',
    version: 1,
    name: 'Technical deep dive',
    description: 'Focus on performance, architecture, security hygiene, technical SEO and runtime problems.',
    icon: 'Wrench',
    missionContext: 'A technical audit for an engineering audience: what limits the site technically, and why.',
    priorityAreas: [
      'Performance and its causes',
      'Architecture and caching signals',
      'Security hygiene (passive only)',
      'Network failures and runtime errors',
      'Technical SEO',
      'Accessibility',
    ],
    suggestedJourneyTypes: ['content-discovery', 'lead', 'purchase'],
    promptAddendum:
      'This is a technical deep dive for an engineering audience. Pay particular attention to performance and its causes (assets, third parties, the render path), architecture and caching signals, security hygiene (TLS, headers, cookies — passive only), network failures and browser/runtime errors, technical SEO (crawlability, canonicals, structured data) and accessibility. Still connect technical problems to the visitor journeys they affect.',
  },
]

export function getTemplate(key: string | null | undefined): AuditTemplate {
  return AUDIT_TEMPLATES.find((t) => t.key === key) ?? AUDIT_TEMPLATES.find((t) => t.key === DEFAULT_TEMPLATE_KEY)!
}

/** "lead-generation@v1": the exact guidance an audit used. */
export function templateRef(template: Pick<AuditTemplate, 'key' | 'version'>): string {
  return `${template.key}@v${template.version}`
}

/** Template an audit used, as stored with it. Null for audits created before templates existed. */
export const AuditTemplateUsage = z.object({ key: AuditTemplateKey, version: z.number().int().positive(), name: z.string() })
export type AuditTemplateUsage = z.infer<typeof AuditTemplateUsage>
