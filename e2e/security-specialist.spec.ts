import { expect, test } from '@playwright/test'
import type { SpecialistAvailability, SpecialistRun, SecurityEngagementDetail } from '@audivra/contracts'

/*
 * Phase 6D end to end, deterministic: the optional specialist engine is NOT installed/enabled in CI, so
 * Audivra must degrade gracefully — the Specialist view shows the availability state, a requested run is
 * recorded, driven by the worker, and reported honestly as unavailable (never as a clean result). This proves
 * the full wired path (API → durable worker → UI) and that a missing specialist never blocks Audivra.
 */

test('the specialist engine degrades gracefully and reports an unavailable run honestly', async ({ page, request }) => {
  test.setTimeout(3 * 60_000)

  const created = await request.post('/api/security/engagements', { data: { name: 'E2E specialist', targetUrl: 'http://127.0.0.1:4331', environment: 'staging' } })
  const engagement = (await created.json()) as SecurityEngagementDetail
  const eid = engagement.id
  await request.post(`/api/security/engagements/${eid}/authorizations`, { data: { method: 'local-development' } })

  // Availability is reported (not installed/enabled in CI) — a missing engine degrades gracefully.
  const availability = (await (await request.get(`/api/security/engagements/${eid}/specialist/availability`)).json()) as SpecialistAvailability
  expect(['disabled', 'missing', 'needs-setup', 'provider-not-configured', 'docker-unavailable']).toContain(availability.state)
  expect(availability.enabledModes).toEqual([]) // no modes until the engine is set up

  // Request a run; the durable worker drives it to an honest terminal state (unavailable), never "clean".
  const requested = await request.post(`/api/security/engagements/${eid}/specialist/runs`, { data: { engine: 'strix', mode: 'source-only', resourceRefs: [], findingIds: [], stagedSourceRef: null, focus: 'broad' } })
  expect(requested.status(), await requested.text()).toBe(202)
  const state = await expect
    .poll(async () => ((await (await request.get(`/api/security/engagements/${eid}/specialist/runs`)).json()) as SpecialistRun[])[0]?.state, { timeout: 90_000 })
    .toBe('unavailable')
  void state

  // The Specialist view renders the availability and the run, keeping Audivra terminology primary.
  await page.goto(`/security/${eid}?tab=specialist`)
  await expect(page.getByText('Specialist engine (Strix)', { exact: false })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('unavailable', { exact: false }).first()).toBeVisible({ timeout: 20_000 })
})
