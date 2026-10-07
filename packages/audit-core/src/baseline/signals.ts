/**
 * Deterministic signal detection (tracking vendors, technology hints). These are cheap leads for the
 * AI auditor — not conclusions. Each hit records what matched so it can be verified.
 */

export interface SignalHit {
  name: string
  category: string
  matched: string
}

interface UrlRule {
  name: string
  category: string
  pattern: RegExp
}

const TRACKING_URL_RULES: UrlRule[] = [
  { name: 'Google Tag Manager', category: 'Tag manager', pattern: /googletagmanager\.com\/gtm\.js/i },
  {
    name: 'Google Analytics 4',
    category: 'Analytics',
    pattern:
      /googletagmanager\.com\/gtag\/js\?id=G-|google-analytics\.com\/g\/collect|analytics\.google\.com\/g\/collect/i,
  },
  {
    name: 'Universal Analytics (legacy)',
    category: 'Analytics',
    pattern: /google-analytics\.com\/(analytics|ga)\.js|\/collect\?v=1/i,
  },
  {
    name: 'Google Ads',
    category: 'Advertising',
    pattern: /googleadservices\.com|googleads\.g\.doubleclick\.net|gtag\/js\?id=AW-/i,
  },
  {
    name: 'Meta Pixel',
    category: 'Advertising',
    pattern: /connect\.facebook\.net\/.*\/fbevents\.js|facebook\.com\/tr[/?]/i,
  },
  { name: 'TikTok Pixel', category: 'Advertising', pattern: /analytics\.tiktok\.com/i },
  { name: 'Snap Pixel', category: 'Advertising', pattern: /sc-static\.net\/scevent|tr\.snapchat\.com/i },
  { name: 'LinkedIn Insight', category: 'Advertising', pattern: /snap\.licdn\.com|px\.ads\.linkedin\.com/i },
  { name: 'Microsoft Ads (UET)', category: 'Advertising', pattern: /bat\.bing\.com/i },
  {
    name: 'X (Twitter) Pixel',
    category: 'Advertising',
    pattern: /static\.ads-twitter\.com|analytics\.twitter\.com/i,
  },
  { name: 'Microsoft Clarity', category: 'Session recording', pattern: /clarity\.ms/i },
  { name: 'Hotjar', category: 'Session recording', pattern: /static\.hotjar\.com|script\.hotjar\.com/i },
  { name: 'Plausible', category: 'Analytics', pattern: /plausible\.io\/js/i },
  { name: 'Segment', category: 'Analytics', pattern: /cdn\.segment\.com/i },
  { name: 'Mixpanel', category: 'Analytics', pattern: /mixpanel\.com/i },
  { name: 'Amplitude', category: 'Analytics', pattern: /amplitude\.com/i },
  { name: 'PostHog', category: 'Analytics', pattern: /posthog\.com|i\.posthog/i },
  { name: 'Yandex Metrica', category: 'Analytics', pattern: /mc\.yandex\.ru/i },
]

const TRACKING_GLOBALS: Record<string, { name: string; category: string }> = {
  dataLayer: { name: 'dataLayer', category: 'Tag manager' },
  gtag: { name: 'gtag()', category: 'Analytics' },
  fbq: { name: 'Meta Pixel (fbq)', category: 'Advertising' },
  ttq: { name: 'TikTok Pixel (ttq)', category: 'Advertising' },
  clarity: { name: 'Microsoft Clarity', category: 'Session recording' },
  hj: { name: 'Hotjar', category: 'Session recording' },
  snaptr: { name: 'Snap Pixel', category: 'Advertising' },
  _linkedin_partner_id: { name: 'LinkedIn Insight', category: 'Advertising' },
}

function dedupe(hits: SignalHit[]): SignalHit[] {
  const seen = new Map<string, SignalHit>()
  for (const hit of hits) if (!seen.has(hit.name)) seen.set(hit.name, hit)
  return [...seen.values()]
}

export function detectTracking(requestUrls: string[], globals: string[]): SignalHit[] {
  const hits: SignalHit[] = []
  for (const url of requestUrls) {
    for (const rule of TRACKING_URL_RULES) {
      if (rule.pattern.test(url))
        hits.push({ name: rule.name, category: rule.category, matched: url.slice(0, 200) })
    }
  }
  for (const global of globals) {
    const rule = TRACKING_GLOBALS[global]
    if (rule) hits.push({ name: rule.name, category: rule.category, matched: `window.${global}` })
  }
  return dedupe(hits)
}

/** Extracts measurement IDs (GA4 G-, GTM-, AW-, Meta pixel IDs) seen in request URLs. */
export interface TrackingEvent {
  tool: string
  event: string
  /** Request URL the event was read from (truncated). */
  url: string
}

/**
 * Events visible in tracking requests: GA4 `collect?en=…`, Meta Pixel `tr?ev=…`, Google Ads conversion
 * hits. Presence of a tag is not the same as an event being sent; this lists what was actually sent.
 */
export function extractTrackingEvents(requestUrls: string[]): TrackingEvent[] {
  const seen = new Set<string>()
  const events: TrackingEvent[] = []
  const add = (tool: string, event: string, url: string) => {
    const key = `${tool}|${event}`
    if (seen.has(key)) return
    seen.add(key)
    events.push({ tool, event, url: url.slice(0, 300) })
  }
  for (const url of requestUrls) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    const host = parsed.hostname
    const params = parsed.searchParams
    if (/(^|\.)google-analytics\.com$|(^|\.)analytics\.google\.com$/.test(host) && /\/g\/collect/.test(parsed.pathname)) {
      const en = params.get('en')
      if (en) add('Google Analytics 4', en, url)
    } else if (/(^|\.)facebook\.com$/.test(host) && /^\/tr\/?$/.test(parsed.pathname)) {
      const ev = params.get('ev')
      if (ev) add('Meta Pixel', ev, url)
    } else if (/googleadservices\.com$|googleads\.g\.doubleclick\.net$/.test(host) && /\/pagead\/(conversion|viewthroughconversion)\//.test(parsed.pathname)) {
      add('Google Ads', /viewthrough/.test(parsed.pathname) ? 'remarketing' : 'conversion', url)
    } else if (/(^|\.)analytics\.tiktok\.com$/.test(host) && /\/api\/v2\/pixel/.test(parsed.pathname)) {
      add('TikTok Pixel', params.get('event') ?? 'pixel request', url)
    }
  }
  return events
}

export function extractTrackingIds(requestUrls: string[]): string[] {
  const ids = new Set<string>()
  for (const url of requestUrls) {
    for (const match of url.matchAll(/[?&](?:id|tid)=((?:G|GTM|AW|UA)-[A-Z0-9-]+)/gi))
      ids.add(match[1]!.toUpperCase())
    const pixel = url.match(/facebook\.com\/tr\/?\?id=(\d+)/i)
    if (pixel) ids.add(`fb:${pixel[1]}`)
  }
  return [...ids]
}

interface TechRule {
  name: string
  category: string
  header?: [string, RegExp]
  url?: RegExp
  html?: RegExp
  global?: string
}

const TECH_RULES: TechRule[] = [
  { name: 'Cloudflare', category: 'CDN', header: ['server', /cloudflare/i] },
  { name: 'Cloudflare', category: 'CDN', header: ['cf-ray', /./] },
  { name: 'Vercel', category: 'Hosting', header: ['x-vercel-id', /./] },
  { name: 'Netlify', category: 'Hosting', header: ['x-nf-request-id', /./] },
  { name: 'Amazon CloudFront', category: 'CDN', header: ['x-amz-cf-id', /./] },
  { name: 'Fastly', category: 'CDN', header: ['x-served-by', /cache-/i] },
  { name: 'Akamai', category: 'CDN', header: ['server', /akamai/i] },
  { name: 'nginx', category: 'Web server', header: ['server', /nginx/i] },
  { name: 'Apache', category: 'Web server', header: ['server', /apache/i] },
  { name: 'LiteSpeed', category: 'Web server', header: ['server', /litespeed/i] },
  { name: 'Microsoft IIS', category: 'Web server', header: ['server', /iis/i] },
  { name: 'PHP', category: 'Language', header: ['x-powered-by', /php/i] },
  { name: 'ASP.NET', category: 'Framework', header: ['x-powered-by', /asp\.net/i] },
  { name: 'Express', category: 'Framework', header: ['x-powered-by', /express/i] },
  { name: 'Next.js', category: 'JS framework', header: ['x-powered-by', /next\.js/i] },
  { name: 'Shopify', category: 'E-commerce', header: ['x-shopify-stage', /./] },
  { name: 'Wix', category: 'Site builder', header: ['x-wix-request-id', /./] },
  { name: 'WordPress', category: 'CMS', url: /\/wp-(content|includes)\//i },
  { name: 'WooCommerce', category: 'E-commerce', url: /\/plugins\/woocommerce\//i },
  { name: 'Elementor', category: 'Page builder', url: /\/plugins\/elementor\//i },
  { name: 'Shopify', category: 'E-commerce', url: /cdn\.shopify\.com/i },
  { name: 'Magento', category: 'E-commerce', url: /\/static\/version\d+\/frontend\//i },
  { name: 'Squarespace', category: 'Site builder', url: /static1\.squarespace\.com/i },
  { name: 'Webflow', category: 'Site builder', html: /data-wf-page/i },
  { name: 'Next.js', category: 'JS framework', url: /\/_next\/static\//i },
  { name: 'Nuxt', category: 'JS framework', url: /\/_nuxt\//i },
  { name: 'Gatsby', category: 'JS framework', global: '___gatsby' },
  { name: 'Astro', category: 'JS framework', html: /<astro-island/i },
  { name: 'Angular', category: 'JS framework', html: /ng-version=/i },
  { name: 'React', category: 'JS library', global: '__REACT' },
  { name: 'Vue.js', category: 'JS framework', global: '__VUE__' },
  { name: 'jQuery', category: 'JS library', global: 'jQuery' },
  { name: 'Bootstrap', category: 'CSS framework', url: /bootstrap(\.min)?\.(css|js)/i },
  { name: 'Font Awesome', category: 'Icons', url: /font-?awesome/i },
  { name: 'Google Fonts', category: 'Fonts', url: /fonts\.googleapis\.com/i },
  { name: 'reCAPTCHA', category: 'Security', url: /recaptcha/i },
  { name: 'Stripe', category: 'Payments', url: /js\.stripe\.com/i },
  { name: 'Intercom', category: 'Live chat', url: /widget\.intercom\.io/i },
  { name: 'Tawk.to', category: 'Live chat', url: /embed\.tawk\.to/i },
  { name: 'Zendesk', category: 'Live chat', url: /static\.zdassets\.com/i },
  { name: 'HubSpot', category: 'Marketing automation', url: /js\.hs-scripts\.com|js\.hsforms\.net/i },
  { name: 'Cookiebot', category: 'Consent', url: /consent\.cookiebot\.com/i },
  { name: 'OneTrust', category: 'Consent', url: /cdn\.cookielaw\.org|onetrust/i },
]

export function detectTechnologies(input: {
  headers: Record<string, string>
  requestUrls: string[]
  html?: string | null
  globals?: string[]
  generator?: string | null
}): SignalHit[] {
  const hits: SignalHit[] = []
  for (const rule of TECH_RULES) {
    if (rule.header) {
      const value = input.headers[rule.header[0]]
      if (value && rule.header[1].test(value))
        hits.push({
          name: rule.name,
          category: rule.category,
          matched: `${rule.header[0]}: ${value}`.slice(0, 120),
        })
    }
    if (rule.url) {
      const url = input.requestUrls.find((u) => rule.url!.test(u))
      if (url) hits.push({ name: rule.name, category: rule.category, matched: url.slice(0, 160) })
    }
    if (rule.html && input.html && rule.html.test(input.html)) {
      hits.push({ name: rule.name, category: rule.category, matched: `html ${rule.html.source}` })
    }
    if (rule.global && input.globals?.some((g) => g.startsWith(rule.global!))) {
      hits.push({ name: rule.name, category: rule.category, matched: `window.${rule.global}` })
    }
  }
  if (input.generator)
    hits.push({
      name: input.generator.split(/\s+/).slice(0, 3).join(' '),
      category: 'Generator',
      matched: `meta generator: ${input.generator}`,
    })
  return dedupe(hits)
}
