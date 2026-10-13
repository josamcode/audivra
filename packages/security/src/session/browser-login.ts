import type { CookieValue } from '@audivra/contracts'
import { chromiumExecutable } from '@audivra/tool-runtime'
import { chromium } from 'playwright'
import type { FormLoginDriver, FormLoginRequest, FormLoginResult } from './establish.ts'

/*
 * The real form-login driver (Phase 5 Step 3): a headless Chromium that loads the login page, types the
 * credential into the declared fields, submits, waits for the declared success signal and returns the
 * resulting cookies. It is TRUSTED code — it is the only place the plaintext password is used, and it is
 * never logged or returned. Navigation is confined to the login origin, so a login page cannot drive the
 * browser (and the credential) to another host. The service seals the returned cookies in the vault; the
 * password itself never leaves this function.
 */

export function createPlaywrightFormLogin(): FormLoginDriver {
  return {
    async login(request: FormLoginRequest): Promise<FormLoginResult> {
      const executablePath = chromiumExecutable()
      const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
      try {
        const context = await browser.newContext({ ignoreHTTPSErrors: true })
        // Confine every request to the login origin: the credential can never be posted to another host.
        await context.route('**/*', (route) => {
          let origin: string | null = null
          try {
            origin = new URL(route.request().url()).origin
          } catch {
            /* malformed: abort below */
          }
          return origin && request.allowedOrigins.includes(origin) ? route.continue() : route.abort()
        })
        const page = await context.newPage()
        page.setDefaultTimeout(request.timeoutMs)
        await page.goto(request.loginUrl, { waitUntil: 'domcontentloaded', timeout: request.timeoutMs })
        await page.fill(request.usernameSelector, request.username)
        await page.fill(request.passwordSelector, request.password)
        await Promise.all([page.waitForLoadState('networkidle', { timeout: request.timeoutMs }).catch(() => undefined), page.click(request.submitSelector)])

        const needle = request.successUrlIncludes
        if (needle && !page.url().includes(needle)) {
          await page.waitForURL((url) => url.toString().includes(needle), { timeout: request.timeoutMs }).catch(() => undefined)
        }
        if (request.successSelector) {
          await page.waitForSelector(request.successSelector, { timeout: request.timeoutMs })
        }

        const cookies: CookieValue[] = (await context.cookies()).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure }))
        return { cookies, finalUrl: page.url() }
      } finally {
        await browser.close().catch(() => undefined)
      }
    },
  }
}
