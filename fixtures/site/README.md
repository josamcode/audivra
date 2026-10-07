# Fixture site

A small "dental clinic" website with intentionally planted problems, used by the integration and
E2E tests (and handy for demos). Run it with `pnpm fixture` → http://127.0.0.1:4321.

Planted issues:

| Area          | Issue                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEO           | Homepage has no meta description; `/services` duplicates the homepage title and has no H1; `/about` duplicates a description and has two H1s; `/services/implants` canonical points to another URL; sitemap lists `/old-offers` (404) |
| Broken        | Links to `/services/old-page` and `/privacy-policy` (404); missing `/img/team-photo.jpg` and `/css/legacy-theme.css`                                                                                                                  |
| JavaScript    | `app.js` throws `ReferenceError: initBookingWidget is not defined` on every page                                                                                                                                                      |
| Mobile        | `.promo-banner` is fixed at 1200px wide → horizontal overflow at 390px                                                                                                                                                                |
| Accessibility | Hero image without `alt`; primary CTA is a clickable `<div>` (not focusable); contact/call-back form fields have no labels; empty submit button; low-contrast text                                                                    |
| Localization  | `/ar/` has `lang="ar"` but no `dir="rtl"`, English CTA/navigation on the Arabic page, no hreflang                                                                                                                                     |
| Tracking      | No analytics or conversion tracking at all (WhatsApp is the main conversion)                                                                                                                                                          |
