import type { SecurityReportAudience, SecurityReportBundle } from '@audivra/contracts'

/*
 * Phase 6F — a self-contained, deterministic HTML renderer for the client report. Pure string output: no
 * scripts, no external requests, inline styles only. It renders from the already-safe bundle, so it contains
 * no secrets. Executive mode shows impact + priorities; technical mode adds evidence/reproduction detail.
 */

const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const li = (items: string[]): string => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="muted">None.</p>')

export function renderSecurityReportHtml(bundle: SecurityReportBundle, options: { audience?: SecurityReportAudience } = {}): string {
  const technical = (options.audience ?? 'technical') === 'technical'
  const m = bundle.meta
  const f = bundle.findings
  const findingRow = (x: (typeof f.verifiedFindings)[number]) =>
    `<tr><td>${esc(x.severity)}</td><td>${esc(x.title)}</td><td>${esc(x.category)}</td><td>${esc(x.verificationState)}</td><td>${esc(x.affectedEntities.map((e) => e.label).join(', '))}</td>${technical ? `<td>${esc(x.impact)}</td><td>${esc(x.remediation)}</td>` : ''}</tr>`
  const findingTable = (rows: typeof f.verifiedFindings) =>
    rows.length
      ? `<table><thead><tr><th>Severity</th><th>Title</th><th>Category</th><th>Verification</th><th>Affected</th>${technical ? '<th>Impact</th><th>Remediation</th>' : ''}</tr></thead><tbody>${rows.map(findingRow).join('')}</tbody></table>`
      : '<p class="muted">None.</p>'
  const pathRow = (p: (typeof bundle.attackPaths.verifiedPaths)[number]) => `<li><strong>${esc(p.state)}</strong> · ${esc(p.start.label)} → ${esc(p.end.label)} <span class="muted">(priority ${esc(p.impactPriority)})</span></li>`

  const sections: string[] = [
    `<section><h2>1. Executive summary</h2><p>${esc(bundle.executiveSummary)}</p></section>`,
    `<section><h2>2. Scope, environment & authorization</h2><table>
      <tr><th>Target</th><td>${esc(m.targetUrl)}</td></tr>
      <tr><th>Environment</th><td>${esc(m.environment ?? 'n/a')}</td></tr>
      <tr><th>Policy profile</th><td>${esc(m.policyProfile.name)} (v${esc(m.policyProfile.version)})</td></tr>
    </table></section>`,
    `<section><h2>3. Methodology</h2><p>${esc(bundle.methodology)}</p></section>`,
    `<section><h2>4. Verified findings (${f.verifiedFindings.length})</h2>${findingTable(f.verifiedFindings)}</section>`,
    `<section><h2>5. Supported / open signals (${f.supportedSignals.length})</h2>${findingTable(f.supportedSignals)}</section>`,
    `<section><h2>6. Attack paths (${bundle.attackPaths.verifiedPaths.length + bundle.attackPaths.partiallyVerifiedPaths.length})</h2>
      <ul>${[...bundle.attackPaths.verifiedPaths, ...bundle.attackPaths.partiallyVerifiedPaths].map(pathRow).join('')}</ul>
      ${bundle.attackPaths.openEvidenceGaps.length ? `<h3>Open evidence gaps</h3>${li(bundle.attackPaths.openEvidenceGaps.map((g) => `${g.title}: ${g.missing.map((x) => x.kind).join(', ')}`))}` : ''}</section>`,
    `<section><h2>7. Identity / authorization & business-logic coverage</h2><table>
      <tr><th>Identities tested</th><td>${esc(bundle.comparisonCoverage.entities.identities)}</td></tr>
      <tr><th>Resources sampled</th><td>${esc(bundle.comparisonCoverage.entities.resources)}</td></tr>
      <tr><th>Controlled comparisons</th><td>${esc(bundle.comparisonCoverage.comparisons.total)}</td></tr>
      <tr><th>Invariants contradicted</th><td>${esc(bundle.comparisonCoverage.invariants.contradicted)}</td></tr>
    </table></section>`,
    bundle.history
      ? `<section><h2>8. Retesting & historical changes</h2><p>${esc(bundle.history.executiveSummary)}</p>
         <table><tr><th>Fixed</th><td>${esc(bundle.history.summary.fixed)}</td></tr><tr><th>Regressed</th><td>${esc(bundle.history.summary.regressed)}</td></tr><tr><th>Still present</th><td>${esc(bundle.history.summary.stillPresent)}</td></tr><tr><th>Not tested</th><td>${esc(bundle.history.summary.notTested)}</td></tr></table></section>`
      : '<section><h2>8. Retesting & historical changes</h2><p class="muted">No previous assessment compared.</p></section>',
    `<section><h2>9. Coverage</h2><table>
      <tr><th>Findings</th><td>${esc(f.coverage.findings.total)}</td></tr>
      <tr><th>Verified</th><td>${esc(f.verifiedFindings.length)}</td></tr>
      <tr><th>Supported</th><td>${esc(f.supportedSignals.length)}</td></tr>
      <tr><th>Attack paths</th><td>${esc(bundle.attackPaths.coverage.total)}</td></tr>
    </table></section>`,
    `<section><h2>10. Residual risk / limitations</h2>
      <h3>Tested</h3>${li(bundle.residual.tested)}
      <h3>Partially tested</h3>${li(bundle.residual.partiallyTested)}
      <h3>Not tested</h3>${li(bundle.residual.notTested)}
      <h3>Still unknown</h3>${li(bundle.residual.unknown)}
      <p class="muted">Audivra does not guarantee finding every vulnerability. Coverage is representative, not exhaustive.</p></section>`,
    `<section class="versions"><h2>11. Reproducibility</h2><table>
      <tr><th>Audivra version</th><td>${esc(m.versions.audivra)}</td></tr>
      <tr><th>Policy profile</th><td>${esc(m.versions.policyProfile.key)} v${esc(m.versions.policyProfile.version)}</td></tr>
      <tr><th>Generated</th><td>${esc(m.generatedAt)}</td></tr>
      ${m.versions.tools.map((t) => `<tr><th>Tool: ${esc(t.name)}</th><td>${esc(t.installed ?? 'not installed')}${t.match ? '' : ' (mismatch)'}</td></tr>`).join('')}
    </table></section>`,
  ]

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Security Assessment — ${esc(m.name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 980px; margin: 0 auto; padding: 2rem 1rem; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: .3rem; }
  h3 { font-size: .95rem; margin: 1rem 0 .3rem; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0; } th, td { border: 1px solid #ddd; padding: .4rem .6rem; text-align: left; vertical-align: top; font-size: .9rem; }
  th { background: #f5f5f5; } .muted { color: #777; } header .sub { color: #555; }
  @media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #111; } th { background: #1d1d1d; } th, td { border-color: #333; } }
</style></head><body>
<header><h1>Authorized Security Assessment</h1><p class="sub">${esc(m.name)} — ${esc(m.targetUrl)} · ${esc(m.environment ?? '')} · Audivra ${esc(m.versions.audivra)}</p></header>
${sections.join('\n')}
</body></html>`
}
