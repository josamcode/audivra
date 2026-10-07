// Deterministic fixture websites with intentionally planted problems, used by tests, the quality
// benchmark and local demos. Variants (see README.md and expectations.json):
//   v1      — "Nile Smile Dental" with planted SEO, broken-link, JS, mobile, accessibility,
//             localization and tracking problems.
//   v2      — the same site after a partial fix: some v1 issues resolved, two new ones introduced
//             (a noindexed contact page and a very heavy hero image). Used for comparison tests.
//   healthy — "Atlas Physio", a small bilingual site without planted problems (false-positive checks).
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const DEFAULT_PORT = Number(process.env.FIXTURE_PORT ?? 4321)
export const VARIANTS = ['v1', 'v2', 'healthy']

const HERO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500" viewBox="0 0 1200 500"><rect width="1200" height="500" fill="#dbeafe"/><circle cx="950" cy="250" r="160" fill="#93c5fd"/><text x="80" y="260" font-family="Arial" font-size="56" fill="#1e3a8a">Healthy smiles in Cairo</text></svg>`

const TEAM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#e0f2fe"/><circle cx="140" cy="150" r="50" fill="#7dd3fc"/><circle cx="260" cy="150" r="50" fill="#38bdf8"/></svg>`

let heavyHero = null
/** An uncompressed 1600×900 24-bit BMP (~4.3 MB): a deterministic, measurable page-weight regression. */
function heavyHeroImage() {
  if (heavyHero) return heavyHero
  const width = 1600
  const height = 900
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const size = 54 + rowSize * height
  const buf = Buffer.alloc(size)
  buf.write('BM', 0)
  buf.writeUInt32LE(size, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(rowSize * height, 34)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = 54 + y * rowSize + x * 3
      buf[offset] = 200 + ((x * 55) / width) | 0 // blue
      buf[offset + 1] = 160 + ((y * 60) / height) | 0 // green
      buf[offset + 2] = 120 + (((x + y) * 40) / (width + height)) | 0 // red
    }
  }
  heavyHero = buf
  return buf
}

const DENTAL_STYLES = `
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

const DENTAL_JS_V1 = `
document.addEventListener('DOMContentLoaded', function () {
  var cta = document.querySelector('.cta');
  if (cta) cta.addEventListener('click', function () { window.location.href = 'https://wa.me/201000000000'; });
  // planted: runtime error
  initBookingWidget();
});
`

const DENTAL_JS_V2 = `
document.addEventListener('DOMContentLoaded', function () {
  var cta = document.querySelector('.cta');
  if (cta) cta.addEventListener('click', function () { window.location.href = 'https://wa.me/201000000000'; });
});
`

/** v1 and v2 share the dental site; v2 differs where noted. */
function dentalSite(variant, port) {
  const v2 = variant === 'v2'
  const base = `http://127.0.0.1:${port}`

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
${v2 ? '' : '<link rel="stylesheet" href="/css/legacy-theme.css">'}
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
        // v1 planted: no meta description on the homepage (fixed in v2)
        description: v2 ? 'Gentle, modern dentistry in Cairo: implants, whitening and family care.' : undefined,
        body: `
<div class="promo-banner">Limited offer: free consultation for new patients this month — book via WhatsApp today!</div>
<main>
  <section class="hero">
    ${v2 ? '<img src="/img/hero-large.bmp" alt="Smiling patient at Nile Smile Dental">' : '<img src="/img/hero.svg">'}
    <h1>Gentle, modern dentistry in Cairo</h1>
    <p>Implants, whitening and family dentistry with transparent pricing.</p>
    <div class="cta" onclick="void 0">Book on WhatsApp</div>
  </section>
  <section>
    <h2>Our services</h2>
    <ul>
      <li><a href="/services/implants">Dental implants</a></li>
      <li><a href="/services/whitening">Teeth whitening</a></li>
      ${v2 ? '' : '<li><a href="/services/old-page">Orthodontics</a></li>'}
    </ul>
    <img src="/img/team-photo.${v2 ? 'svg' : 'jpg'}" width="400" height="300"${v2 ? ' alt="Our dental team"' : ''}>
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
        // v2 planted: the contact page was accidentally noindexed
        extraHead: v2 ? '<meta name="robots" content="noindex, nofollow">' : '',
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
    '/styles.css': ['text/css', DENTAL_STYLES],
    '/app.js': ['application/javascript', v2 ? DENTAL_JS_V2 : DENTAL_JS_V1],
    '/img/hero.svg': ['image/svg+xml', HERO_SVG],
    '/img/implant.svg': ['image/svg+xml', HERO_SVG.replace('Healthy smiles in Cairo', 'Implants')],
    '/robots.txt': ['text/plain', `User-agent: *\nDisallow: /admin/\nSitemap: ${base}/sitemap.xml\n`],
  }
  if (v2) {
    assets['/img/team-photo.svg'] = ['image/svg+xml', TEAM_SVG]
    assets['/img/hero-large.bmp'] = ['image/bmp', null]
  }

  const sitemapUrls = ['/', '/services', '/services/implants', '/services/whitening', '/about', '/contact', '/ar/', '/old-offers']
  return {
    pages,
    assets,
    sitemapUrls,
    headers: { 'x-powered-by': 'FixtureServer/1.0' },
    resolvePage: (path) => pages[path] ?? pages[path.replace(/\/$/, '')] ?? (path === '/ar' ? pages['/ar/'] : undefined),
  }
}

const ATLAS_STYLES = `
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6; font-size: 17px; }
header { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e5e7eb; }
nav { display: flex; flex-wrap: wrap; gap: 14px; }
nav a { color: #1d4ed8; }
main { padding: 20px; max-width: 960px; margin: 0 auto; }
img { max-width: 100%; height: auto; }
.cta { display: inline-block; background: #166534; color: #ffffff; padding: 14px 22px; border-radius: 6px; text-decoration: none; font-weight: bold; }
.cta:focus-visible, a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
footer { padding: 20px; border-top: 1px solid #e5e7eb; margin-top: 40px; font-size: 16px; color: #374151; }
label { display: block; margin-top: 12px; font-weight: bold; }
input, textarea { display: block; width: 100%; max-width: 420px; padding: 10px; margin-top: 4px; font-size: 16px; }
button { margin-top: 16px; padding: 12px 20px; font-size: 16px; background: #1d4ed8; color: #fff; border: 0; border-radius: 6px; }
[dir="rtl"] body, [dir="rtl"] { text-align: right; }
`

let atlasFavicon = null
/** A 16×16 32-bit .ico (the healthy site must not 404 on /favicon.ico). */
function faviconIco() {
  if (atlasFavicon) return atlasFavicon
  const size = 16
  const pixelBytes = size * size * 4
  const maskBytes = size * 4
  const bmpSize = 40 + pixelBytes + maskBytes
  const buf = Buffer.alloc(6 + 16 + bmpSize)
  buf.writeUInt16LE(0, 0)
  buf.writeUInt16LE(1, 2)
  buf.writeUInt16LE(1, 4)
  buf[6] = size
  buf[7] = size
  buf.writeUInt16LE(1, 10)
  buf.writeUInt16LE(32, 12)
  buf.writeUInt32LE(bmpSize, 14)
  buf.writeUInt32LE(22, 18)
  const o = 22
  buf.writeUInt32LE(40, o)
  buf.writeInt32LE(size, o + 4)
  buf.writeInt32LE(size * 2, o + 8)
  buf.writeUInt16LE(1, o + 12)
  buf.writeUInt16LE(32, o + 14)
  buf.writeUInt32LE(pixelBytes + maskBytes, o + 20)
  for (let i = 0; i < size * size; i++) {
    const p = o + 40 + i * 4
    buf[p] = 0x3d // B
    buf[p + 1] = 0x65 // G
    buf[p + 2] = 0x16 // R
    buf[p + 3] = 0xff
  }
  atlasFavicon = buf
  return buf
}

const ATLAS_HERO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="360" viewBox="0 0 960 360"><rect width="960" height="360" fill="#ecfdf5"/><circle cx="760" cy="180" r="120" fill="#a7f3d0"/><circle cx="220" cy="230" r="70" fill="#d1fae5"/></svg>`

function healthySite(port) {
  const base = `http://127.0.0.1:${port}`
  const t = {
    en: {
      dir: 'ltr',
      name: 'Atlas Physio',
      nav: [['/', 'Home'], ['/services', 'Services'], ['/about', 'About'], ['/contact', 'Contact']],
      switch: ['/ar/', 'العربية'],
      footer: 'Atlas Physio · 4 Garden St, Alexandria',
      privacy: 'Privacy policy',
    },
    ar: {
      dir: 'rtl',
      name: 'أطلس للعلاج الطبيعي',
      nav: [['/ar/', 'الرئيسية'], ['/ar/services', 'الخدمات'], ['/ar/about', 'من نحن'], ['/ar/contact', 'اتصل بنا']],
      switch: ['/', 'English'],
      footer: 'أطلس للعلاج الطبيعي · ٤ شارع الحديقة، الإسكندرية',
      privacy: 'سياسة الخصوصية',
    },
  }
  const pair = (enPath, arPath) => ({ en: enPath, ar: arPath })
  const pairs = {
    home: pair('/', '/ar/'),
    services: pair('/services', '/ar/services'),
    about: pair('/about', '/ar/about'),
    contact: pair('/contact', '/ar/contact'),
    privacy: pair('/privacy', '/ar/privacy'),
  }

  function layout(lang, key, { title, description, body }) {
    const l = t[lang]
    const own = pairs[key][lang]
    return `<!doctype html>
<html lang="${lang}" dir="${l.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${base}${own}">
<link rel="alternate" hreflang="en" href="${base}${pairs[key].en}">
<link rel="alternate" hreflang="ar" href="${base}${pairs[key].ar}">
<link rel="alternate" hreflang="x-default" href="${base}${pairs[key].en}">
<link rel="icon" href="/favicon.ico" sizes="16x16">
<link rel="stylesheet" href="/styles.css">
${key === 'home' ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'MedicalBusiness', name: l.name, url: `${base}${own}`, telephone: '+203000000000', priceRange: '600-750 EGP', address: { '@type': 'PostalAddress', streetAddress: '4 Garden St', addressLocality: 'Alexandria', addressCountry: 'EG' } })}</script>` : ''}
</head>
<body>
<header>
  <a href="${pairs.home[lang]}"><strong>${l.name}</strong></a>
  <nav aria-label="${lang === 'ar' ? 'القائمة الرئيسية' : 'Main navigation'}">
    ${l.nav.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}
    <a href="${pairs[key][lang === 'ar' ? 'en' : 'ar']}" hreflang="${lang === 'ar' ? 'en' : 'ar'}" lang="${lang === 'ar' ? 'en' : 'ar'}">${l.switch[1]}</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  <p>${l.footer} · <a href="tel:+203000000000" dir="ltr">+20 3 000 0000</a> · <a href="https://wa.me/203000000000">WhatsApp</a> · <a href="${pairs.privacy[lang]}">${l.privacy}</a></p>
</footer>
</body>
</html>`
  }

  const contactForm = (lang) =>
    lang === 'ar'
      ? `<form action="/ar/thank-you" method="post">
  <label for="name">الاسم</label><input id="name" name="name" autocomplete="name" required>
  <label for="phone">رقم الهاتف</label><input id="phone" name="phone" type="tel" autocomplete="tel" required>
  <label for="message">رسالتك</label><textarea id="message" name="message" rows="4"></textarea>
  <button type="submit">إرسال الطلب</button>
</form>`
      : `<form action="/thank-you" method="post">
  <label for="name">Name</label><input id="name" name="name" autocomplete="name" required>
  <label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel" required>
  <label for="message">Message</label><textarea id="message" name="message" rows="4"></textarea>
  <button type="submit">Send request</button>
</form>`

  const pages = {
    '/': () =>
      layout('en', 'home', {
        title: 'Atlas Physio — Physiotherapy in Alexandria',
        description: 'Evidence-based physiotherapy for back pain, sports injuries and rehabilitation in Alexandria.',
        body: `<img src="/img/hero.svg" width="960" height="360" alt="">
<h1>Physiotherapy in Alexandria</h1>
<p>Evidence-based treatment for back pain, sports injuries and post-surgery rehabilitation. Same-week appointments.</p>
<p><a class="cta" href="https://wa.me/203000000000">Book on WhatsApp</a></p>
<h2>Why patients choose us</h2>
<ul><li>Licensed physiotherapists with 10+ years of experience</li><li>45-minute one-to-one sessions</li><li>Clear prices before you book</li></ul>
<p><a href="/services">See our services and prices</a></p>`,
      }),
    '/services': () =>
      layout('en', 'services', {
        title: 'Services and prices | Atlas Physio',
        description: 'Back pain treatment, sports injury rehabilitation and post-surgery physiotherapy with clear prices.',
        body: `<h1>Services and prices</h1>
<ul><li>Back and neck pain — 600 EGP per session</li><li>Sports injury rehabilitation — 700 EGP per session</li><li>Post-surgery rehabilitation — 750 EGP per session</li></ul>
<p><a class="cta" href="/contact">Request an appointment</a></p>`,
      }),
    '/about': () =>
      layout('en', 'about', {
        title: 'About Atlas Physio',
        description: 'Meet the Atlas Physio team of licensed physiotherapists in Alexandria.',
        body: `<h1>About Atlas Physio</h1><p>Founded in 2015, our team of four licensed physiotherapists treats more than 2,000 patients a year.</p>`,
      }),
    '/contact': () =>
      layout('en', 'contact', {
        title: 'Contact and booking | Atlas Physio',
        description: 'Book a physiotherapy appointment by WhatsApp, phone or the booking form.',
        body: `<h1>Book an appointment</h1><p>Message us on <a href="https://wa.me/203000000000">WhatsApp</a>, call <a href="tel:+203000000000" dir="ltr">+20 3 000 0000</a> or send the form.</p>${contactForm('en')}`,
      }),
    '/privacy': () =>
      layout('en', 'privacy', {
        title: 'Privacy policy | Atlas Physio',
        description: 'How Atlas Physio handles the personal data you share with us.',
        body: `<h1>Privacy policy</h1><p>We only use the details you send to arrange your appointment and never share them.</p>`,
      }),
    '/thank-you': () =>
      layout('en', 'contact', { title: 'Thank you | Atlas Physio', description: 'Your request was received.', body: '<h1>Thank you</h1><p>We will call you back today.</p>' }),
    '/ar/': () =>
      layout('ar', 'home', {
        title: 'أطلس للعلاج الطبيعي في الإسكندرية',
        description: 'علاج طبيعي قائم على الأدلة لآلام الظهر وإصابات الملاعب وإعادة التأهيل في الإسكندرية.',
        body: `<img src="/img/hero.svg" width="960" height="360" alt="">
<h1>العلاج الطبيعي في الإسكندرية</h1>
<p>علاج قائم على الأدلة لآلام الظهر وإصابات الملاعب وإعادة التأهيل بعد الجراحة. مواعيد في نفس الأسبوع.</p>
<p><a class="cta" href="https://wa.me/203000000000">احجز عبر واتساب</a></p>
<h2>لماذا يختارنا المرضى</h2>
<ul><li>أخصائيون مرخصون بخبرة تزيد عن ١٠ سنوات</li><li>جلسات فردية مدتها ٤٥ دقيقة</li><li>أسعار واضحة قبل الحجز</li></ul>
<p><a href="/ar/services">اطّلع على الخدمات والأسعار</a></p>`,
      }),
    '/ar/services': () =>
      layout('ar', 'services', {
        title: 'الخدمات والأسعار | أطلس للعلاج الطبيعي',
        description: 'علاج آلام الظهر وإعادة تأهيل إصابات الملاعب والعلاج الطبيعي بعد الجراحة بأسعار واضحة.',
        body: `<h1>الخدمات والأسعار</h1>
<ul><li>آلام الظهر والرقبة — ٦٠٠ جنيه للجلسة</li><li>إعادة تأهيل إصابات الملاعب — ٧٠٠ جنيه للجلسة</li><li>إعادة التأهيل بعد الجراحة — ٧٥٠ جنيه للجلسة</li></ul>
<p><a class="cta" href="/ar/contact">اطلب موعدًا</a></p>`,
      }),
    '/ar/about': () =>
      layout('ar', 'about', {
        title: 'من نحن | أطلس للعلاج الطبيعي',
        description: 'تعرّف على فريق أطلس من أخصائيي العلاج الطبيعي المرخصين في الإسكندرية.',
        body: `<h1>من نحن</h1><p>تأسس أطلس عام ٢٠١٥، ويعالج فريقنا المكوّن من أربعة أخصائيين مرخصين أكثر من ٢٠٠٠ مريض سنويًا.</p>`,
      }),
    '/ar/contact': () =>
      layout('ar', 'contact', {
        title: 'التواصل والحجز | أطلس للعلاج الطبيعي',
        description: 'احجز موعد علاج طبيعي عبر واتساب أو الهاتف أو نموذج الحجز.',
        body: `<h1>احجز موعدًا</h1><p>راسلنا عبر <a href="https://wa.me/203000000000">واتساب</a> أو اتصل على <a href="tel:+203000000000" dir="ltr">+20 3 000 0000</a> أو أرسل النموذج.</p>${contactForm('ar')}`,
      }),
    '/ar/privacy': () =>
      layout('ar', 'privacy', {
        title: 'سياسة الخصوصية | أطلس للعلاج الطبيعي',
        description: 'كيف يتعامل أطلس مع البيانات الشخصية التي تشاركها معنا.',
        body: `<h1>سياسة الخصوصية</h1><p>نستخدم بياناتك فقط لترتيب موعدك ولا نشاركها مع أي طرف.</p>`,
      }),
    '/ar/thank-you': () =>
      layout('ar', 'contact', { title: 'شكرًا | أطلس للعلاج الطبيعي', description: 'تم استلام طلبك.', body: '<h1>شكرًا لك</h1><p>سنتصل بك اليوم.</p>' }),
  }
  const assets = {
    '/styles.css': ['text/css', ATLAS_STYLES],
    '/img/hero.svg': ['image/svg+xml', ATLAS_HERO_SVG],
    '/favicon.ico': ['image/x-icon', null],
    '/robots.txt': ['text/plain', `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`],
  }
  const sitemapUrls = ['/', '/services', '/about', '/contact', '/privacy', '/ar/', '/ar/services', '/ar/about', '/ar/contact', '/ar/privacy']
  return {
    pages,
    assets,
    sitemapUrls,
    headers: {
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'x-frame-options': 'DENY',
      'cache-control': 'public, max-age=300',
    },
    resolvePage: (path) => pages[path] ?? pages[path.replace(/\/$/, '')] ?? (path === '/ar' ? pages['/ar/'] : undefined),
    // A branded, localized "not found" page with a way back (not indexed).
    notFound: (path) => {
      const lang = path.startsWith('/ar') ? 'ar' : 'en'
      const l = t[lang]
      return `<!doctype html>
<html lang="${lang}" dir="${l.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${lang === 'ar' ? 'الصفحة غير موجودة | أطلس للعلاج الطبيعي' : 'Page not found | Atlas Physio'}</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.ico" sizes="16x16">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header>
  <a href="${pairs.home[lang]}"><strong>${l.name}</strong></a>
  <nav aria-label="${lang === 'ar' ? 'القائمة الرئيسية' : 'Main navigation'}">${l.nav.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}</nav>
</header>
<main>
${lang === 'ar'
  ? `<h1>الصفحة غير موجودة</h1><p>ربما تغيّر الرابط. يمكنك العودة إلى <a href="/ar/">الصفحة الرئيسية</a> أو <a href="/ar/contact">حجز موعد</a>.</p>`
  : `<h1>Page not found</h1><p>The link may have changed. Go back to the <a href="/">homepage</a> or <a href="/contact">book an appointment</a>.</p>`}
</main>
<footer>
  <p>${l.footer} · <a href="tel:+203000000000" dir="ltr">+20 3 000 0000</a> · <a href="https://wa.me/203000000000">WhatsApp</a></p>
</footer>
</body>
</html>`
    },
  }
}

function createHandler(variant, getPort) {
  let site = null
  let sitePort = null
  const current = () => {
    const port = getPort()
    if (!site || sitePort !== port) {
      site = variant === 'healthy' ? healthySite(port) : dentalSite(variant, port)
      sitePort = port
    }
    return site
  }
  return function handler(req, res) {
    const s = current()
    const port = getPort()
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const path = url.pathname
    if (path === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml', ...s.headers })
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${s.sitemapUrls.map((u) => `  <url><loc>http://127.0.0.1:${port}${u}</loc></url>`).join('\n')}
</urlset>`)
    }
    if (s.assets[path]) {
      const [type, body] = s.assets[path]
      const content = body ?? (path === '/img/hero-large.bmp' ? heavyHeroImage() : path === '/favicon.ico' ? faviconIco() : '')
      res.writeHead(200, { 'content-type': type, ...s.headers })
      return res.end(req.method === 'HEAD' ? undefined : content)
    }
    if (req.method === 'POST' && (path === '/thank-you' || path === '/ar/thank-you')) {
      res.writeHead(303, { location: path })
      return res.end()
    }
    const page = s.resolvePage(path)
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...s.headers })
      return res.end(req.method === 'HEAD' ? undefined : page())
    }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', ...s.headers })
    res.end(s.notFound ? s.notFound(path) : '<!doctype html><html lang="en"><title>Not found</title><h1>404</h1>')
  }
}

/**
 * Starts a fixture variant on 127.0.0.1 (port 0 picks a free port).
 * Resolves with the server and its base URL. Each server instance is independent.
 */
export function startFixtureServer(port = DEFAULT_PORT, options = {}) {
  const variant = options.variant ?? 'v1'
  if (!VARIANTS.includes(variant)) throw new Error(`Unknown fixture variant: ${variant}`)
  return new Promise((resolve, reject) => {
    let actualPort = port
    const server = http.createServer(createHandler(variant, () => actualPort))
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port
      resolve({ server, url: `http://127.0.0.1:${actualPort}`, variant })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const variantArg = process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1]
  const variants = variantArg ? variantArg.split(',') : ['v1']
  for (const [index, variant] of variants.entries()) {
    const { url } = await startFixtureServer(DEFAULT_PORT + index, { variant })
    console.log(`Fixture site (${variant}) on ${url}`)
  }
}
