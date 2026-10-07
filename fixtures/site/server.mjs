// Deterministic fixture website with intentionally planted problems, used by tests and local demos.
// Planted issues (see README.md): missing alt, broken links/resources, duplicate & missing metadata,
// JS console error, mobile horizontal overflow, inaccessible controls, Arabic page without dir="rtl",
// no analytics/tracking, wrong canonical, sitemap entry that 404s.
import http from 'node:http'
import { pathToFileURL } from 'node:url'

let PORT = Number(process.env.FIXTURE_PORT ?? 4321)

const HERO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500" viewBox="0 0 1200 500"><rect width="1200" height="500" fill="#dbeafe"/><circle cx="950" cy="250" r="160" fill="#93c5fd"/><text x="80" y="260" font-family="Arial" font-size="56" fill="#1e3a8a">Healthy smiles in Cairo</text></svg>`

const STYLES = `
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, sans-serif; color: #1f2937; }
header { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; border-bottom: 1px solid #e5e7eb; }
nav a { margin-right: 16px; color: #1d4ed8; }
main { padding: 24px; max-width: 1100px; margin: 0 auto; }
.promo-banner { width: 1200px; background: #fef3c7; padding: 12px; } /* planted: fixed width causes mobile overflow */
.hero img { width: 100%; height: auto; }
.cta { display: inline-block; background: #16a34a; color: white; padding: 14px 22px; border-radius: 6px; cursor: pointer; }
.muted { color: #c7cbd1; } /* planted: low contrast */
footer { padding: 24px; border-top: 1px solid #e5e7eb; margin-top: 48px; font-size: 14px; }
form label { display: block; margin-top: 12px; }
input, textarea { display: block; width: 100%; max-width: 420px; padding: 8px; margin-top: 4px; }
`

const APP_JS = `
document.addEventListener('DOMContentLoaded', function () {
  var cta = document.querySelector('.cta');
  if (cta) cta.addEventListener('click', function () { window.location.href = 'https://wa.me/201000000000'; });
  // planted: runtime error
  initBookingWidget();
});
`

function layout({ title, description, lang = 'en', dir, canonical, body, extraHead = '' }) {
  return `<!doctype html>
<html lang="${lang}"${dir ? ` dir="${dir}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${description ? `<meta name="description" content="${description}">` : ''}
${canonical ? `<link rel="canonical" href="${canonical}">` : ''}
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/css/legacy-theme.css">
${extraHead}
</head>
<body>
<header>
  <a href="/"><strong>Nile Smile Dental</strong></a>
  <nav>
    <a href="/">Home</a><a href="/services">Services</a><a href="/about">About</a><a href="/contact">Contact</a><a href="/ar/">العربية</a>
  </nav>
</header>
${body}
<footer>
  <p>Nile Smile Dental · 12 Corniche St, Cairo · <a href="tel:+201000000000">+20 100 000 0000</a></p>
  <p><a href="/privacy-policy">Privacy policy</a> · <a href="https://wa.me/201000000000">WhatsApp</a></p>
</footer>
<script src="/app.js"></script>
</body>
</html>`
}

const pages = {
  '/': () =>
    layout({
      title: 'Nile Smile Dental',
      // planted: no meta description on the homepage
      body: `
<div class="promo-banner">Limited offer: free consultation for new patients this month — book via WhatsApp today!</div>
<main>
  <section class="hero">
    <img src="/img/hero.svg">
    <h1>Gentle, modern dentistry in Cairo</h1>
    <p>Implants, whitening and family dentistry with transparent pricing.</p>
    <div class="cta" onclick="void 0">Book on WhatsApp</div>
  </section>
  <section>
    <h2>Our services</h2>
    <ul>
      <li><a href="/services/implants">Dental implants</a></li>
      <li><a href="/services/whitening">Teeth whitening</a></li>
      <li><a href="/services/old-page">Orthodontics</a></li>
    </ul>
    <img src="/img/team-photo.jpg" width="400" height="300">
  </section>
  <p class="muted">Rated 4.9 by 300+ patients.</p>
</main>`,
    }),
  '/services': () =>
    layout({
      title: 'Nile Smile Dental', // planted: duplicate title
      description: 'Dental services in Cairo',
      body: `<main><h2>Services</h2><p>Explore our treatments.</p>
      <ul><li><a href="/services/implants">Implants</a></li><li><a href="/services/whitening">Whitening</a></li></ul></main>`,
    }),
  '/services/implants': () =>
    layout({
      title: 'Dental Implants in Cairo | Nile Smile Dental',
      description: 'Permanent dental implants with 10-year warranty.',
      canonical: 'http://localhost:9/services', // planted: canonical points to a different URL
      body: `<main><h1>Dental implants</h1><p>Starting from 15,000 EGP.</p>
      <img src="/img/implant.svg" alt="">
      <h2>Request a call back</h2>
      <form action="/thank-you" method="post">
        <input name="name" placeholder="Name">
        <input name="phone" placeholder="Phone">
        <div class="cta" onclick="this.closest('form').submit()">Send</div>
      </form></main>`,
    }),
  '/services/whitening': () =>
    layout({
      title: 'Teeth Whitening | Nile Smile Dental',
      description: 'Professional teeth whitening.',
      body: `<main><h1>Teeth whitening</h1><p>One-hour in-clinic whitening.</p></main>`,
    }),
  '/about': () =>
    layout({
      title: 'About us | Nile Smile Dental',
      description: 'Dental services in Cairo', // planted: duplicate description
      body: `<main><h1>About Nile Smile</h1><h1>Our team</h1><p class="muted">Founded in 2012 by Dr. Mona Adel.</p></main>`,
    }),
  '/contact': () =>
    layout({
      title: 'Contact | Nile Smile Dental',
      description: 'Book an appointment.',
      body: `<main><h1>Contact us</h1>
      <form action="/thank-you" method="post">
        <input name="email" type="email" placeholder="Email">
        <textarea name="message"></textarea>
        <button type="submit"></button>
      </form>
      <p>Or message us on <a href="https://wa.me/201000000000">WhatsApp</a>.</p></main>`,
    }),
  '/ar/': () =>
    layout({
      title: 'عيادة نايل سمايل لطب الأسنان',
      description: 'عيادة أسنان في القاهرة',
      lang: 'ar', // planted: Arabic page without dir="rtl"
      body: `<main><h1>طب أسنان حديث ولطيف في القاهرة</h1>
      <p>زراعة الأسنان، التبييض، وطب أسنان الأسرة بأسعار واضحة.</p>
      <div class="cta">Book on WhatsApp</div>
      <p>اتصل بنا الآن للحصول على استشارة مجانية.</p></main>`,
    }),
  '/thank-you': () => layout({ title: 'Thank you', body: '<main><h1>Thanks!</h1></main>' }),
}

const assets = {
  '/styles.css': ['text/css', STYLES],
  '/app.js': ['application/javascript', APP_JS],
  '/img/hero.svg': ['image/svg+xml', HERO_SVG],
  '/img/implant.svg': ['image/svg+xml', HERO_SVG.replace('Healthy smiles in Cairo', 'Implants')],
  '/robots.txt': [
    'text/plain',
    `User-agent: *\nDisallow: /admin/\nSitemap: http://127.0.0.1:${PORT}/sitemap.xml\n`,
  ],
}

function sitemap() {
  const urls = [
    '/',
    '/services',
    '/services/implants',
    '/services/whitening',
    '/about',
    '/contact',
    '/ar/',
    '/old-offers',
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>http://127.0.0.1:${PORT}${u}</loc></url>`).join('\n')}
</urlset>`
}

function handler(req, res) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml' })
    return res.end(sitemap())
  }
  if (assets[path]) {
    const [type, body] = assets[path]
    res.writeHead(200, { 'content-type': type })
    return res.end(req.method === 'HEAD' ? undefined : body)
  }
  if (req.method === 'POST' && path === '/thank-you') {
    res.writeHead(303, { location: '/thank-you' })
    return res.end()
  }
  const page = pages[path] ?? pages[path.replace(/\/$/, '')] ?? (path === '/ar' ? pages['/ar/'] : undefined)
  if (page) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-powered-by': 'FixtureServer/1.0' })
    return res.end(req.method === 'HEAD' ? undefined : page())
  }
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>Not found</title><h1>404</h1>')
}

/** Starts the fixture on 127.0.0.1 (port 0 picks a free port). Resolves with the server and its base URL. */
export function startFixtureServer(port = PORT) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res))
    server.listen(port, '127.0.0.1', () => {
      PORT = server.address().port
      resolve({ server, url: `http://127.0.0.1:${PORT}` })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { url } = await startFixtureServer()
  console.log(`Fixture site on ${url}`)
}
