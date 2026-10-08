import {
  ARTIFACT_DATA_SCHEMAS,
  MIN_TREND_POINTS,
  SEVERITY_RANK,
  type ArtifactSpec,
  type ArtifactType,
  type AuditComparison,
  type AuditSummary,
  type Datum,
  type EvidenceItem,
  type FindingItem,
  type JourneyItem,
  type MetricCatalogEntry,
  type Severity,
  type SiteHistory,
  type ValueUnit,
} from '@audivra/contracts'
import type { NewArtifact } from '@audivra/database'
import { evidenceKind, pagePath, startPagePath } from './catalog.ts'
import { evidenceNumbers, isGrounded } from './grounding.ts'

export interface LinkGraph {
  pages: { url: string; depth: number; title: string | null }[]
  edges: { from: string; to: string }[]
}

export interface ResolveContext {
  evidence: EvidenceItem[]
  findings: FindingItem[]
  catalog: MetricCatalogEntry[]
  summary: AuditSummary | null
  history: SiteHistory | null
  comparison: AuditComparison | null
  linkGraph: LinkGraph | null
  /** Stored journeys of the audit (a `journey` spec may reference one by ID). */
  journeys: JourneyItem[]
  /** Image dimensions for a workspace-relative path; null if missing/not an image. */
  imageSize: (workspacePath: string) => Promise<{ width: number; height: number } | null>
}

export interface ResolveResult {
  artifact: NewArtifact | null
  issues: string[]
}

const IMAGE_RE = /\.(png|jpe?g|webp)$/i

function normalizeRef(ref: string): string {
  const match = ref.trim().match(/^ev-?(\d+)$/i)
  return match ? `EV-${Number(match[1])}` : ref.trim()
}

function normalizeFindingRef(ref: string): string {
  const match = ref.trim().match(/^f-?(\d+)$/i)
  return match ? `F${Number(match[1])}` : ref.trim()
}

class Resolver {
  readonly issues: string[] = []
  readonly usedEvidence = new Set<string>()
  private readonly evidenceByRef: Map<string, EvidenceItem>
  private readonly numbersByRef = new Map<string, number[]>()
  private readonly catalogByKey: Map<string, MetricCatalogEntry>
  private readonly findingRefs: Set<string>

  constructor(readonly ctx: ResolveContext) {
    this.evidenceByRef = new Map(ctx.evidence.map((e) => [e.ref, e]))
    this.catalogByKey = new Map(ctx.catalog.map((e) => [e.key, e]))
    this.findingRefs = new Set(ctx.findings.map((f) => f.ref))
  }

  evidence(ref: string | undefined): EvidenceItem | undefined {
    if (!ref) return undefined
    return this.evidenceByRef.get(normalizeRef(ref))
  }

  validEvidenceRef(ref: string | undefined, where: string): string | undefined {
    if (!ref) return undefined
    const item = this.evidence(ref)
    if (!item) {
      this.issues.push(`${where}: evidence ${ref} does not exist`)
      return undefined
    }
    this.usedEvidence.add(item.ref)
    return item.ref
  }

  validFindingRef(ref: string | undefined, where: string): string | undefined {
    if (!ref) return undefined
    const normalized = normalizeFindingRef(ref)
    if (!this.findingRefs.has(normalized)) {
      this.issues.push(`${where}: finding ${ref} does not exist`)
      return undefined
    }
    return normalized
  }

  catalogEntry(key: string): MetricCatalogEntry | undefined {
    const direct = this.catalogByKey.get(key)
    if (direct) return direct
    // Tolerate trailing-slash differences in page paths: "lighthouse:/ar/:mobile:lcp" vs "/ar".
    const alt = key.replace(/:(\/[^:]*?)\/+:/, ':$1:')
    return this.catalogByKey.get(alt)
  }

  /** Grounds a datum: catalog key (value filled by Audivra) or literal value found in cited evidence. */
  datum(raw: unknown, where: string): Datum | null {
    if (!raw || typeof raw !== 'object') return null
    const d = raw as Record<string, unknown>
    const label = typeof d.label === 'string' && d.label.trim() ? d.label.trim().slice(0, 80) : null
    if (typeof d.metricKey === 'string') {
      const entry = this.catalogEntry(d.metricKey)
      if (!entry) {
        this.issues.push(`${where}: metric ${d.metricKey} is not in the catalog`)
        return null
      }
      this.usedEvidence.add(entry.evidenceId)
      return {
        label: label ?? entry.label.slice(0, 80),
        value: entry.value,
        unit: entry.unit,
        metricKey: entry.key,
        evidenceId: entry.evidenceId,
        tone: tone(d.tone),
        note: typeof d.note === 'string' ? d.note.slice(0, 200) : undefined,
      }
    }
    const value = typeof d.value === 'number' ? d.value : Number.NaN
    if (!Number.isFinite(value)) {
      this.issues.push(`${where}: value is not a finite number`)
      return null
    }
    const item = this.evidence(typeof d.evidenceId === 'string' ? d.evidenceId : undefined)
    if (!item) {
      this.issues.push(`${where}: value ${value} has neither a catalog metricKey nor existing evidence`)
      return null
    }
    let numbers = this.numbersByRef.get(item.ref)
    if (!numbers) {
      numbers = evidenceNumbers(item)
      this.numbersByRef.set(item.ref, numbers)
    }
    if (!isGrounded(value, numbers)) {
      this.issues.push(`${where}: value ${value} does not appear in ${item.ref}`)
      return null
    }
    this.usedEvidence.add(item.ref)
    return {
      label: label ?? 'Value',
      value,
      unit: unit(d.unit),
      evidenceId: item.ref,
      tone: tone(d.tone),
      note: typeof d.note === 'string' ? d.note.slice(0, 200) : undefined,
    }
  }

  datumList(raw: unknown, where: string): Datum[] {
    if (!Array.isArray(raw)) return []
    return raw.map((d, i) => this.datum(d, `${where}[${i}]`)).filter((d): d is Datum => d !== null)
  }

  async image(ref: string | undefined, where: string): Promise<{ ref: string; path: string; width: number; height: number } | null> {
    const item = this.evidence(ref)
    if (!item) {
      this.issues.push(`${where}: evidence ${ref ?? '(none)'} does not exist`)
      return null
    }
    if (!item.artifactPath || !IMAGE_RE.test(item.artifactPath)) {
      this.issues.push(`${where}: ${item.ref} has no image file`)
      return null
    }
    const size = await this.ctx.imageSize(item.artifactPath)
    if (!size) {
      this.issues.push(`${where}: image for ${item.ref} could not be read`)
      return null
    }
    this.usedEvidence.add(item.ref)
    return { ref: item.ref, path: item.artifactPath, ...size }
  }
}

const tone = (v: unknown): Datum['tone'] =>
  v === 'good' || v === 'bad' || v === 'warning' || v === 'neutral' ? v : undefined
const UNITS: ValueUnit[] = ['ms', 's', 'score', 'count', 'bytes', 'kb', 'percent', 'px', 'ratio', 'days', 'none']
const unit = (v: unknown): ValueUnit => (UNITS.includes(v as ValueUnit) ? (v as ValueUnit) : 'none')
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

const LIGHTHOUSE_COLUMN_KEYS: Record<string, string> = {
  performance: 'performance',
  accessibility: 'accessibility',
  seo: 'seo',
  bestPractices: 'bestPractices',
  lcp: 'lcp',
  fcp: 'fcp',
  cls: 'cls',
  tbt: 'tbt',
  weight: 'weight',
}

/** Builds the page_performance table from the catalog — the planner only chooses pages and columns. */
function buildPagePerformance(r: Resolver, data: Record<string, unknown>): Record<string, unknown> | null {
  const formFactor = data.formFactor === 'desktop' ? 'desktop' : 'mobile'
  const columns = asArray(data.columns).filter((c): c is string => typeof c === 'string' && (c in LIGHTHOUSE_COLUMN_KEYS || c === 'requests'))
  const rows: { url: string; label?: string; values: Record<string, Datum | null> }[] = []
  for (const rawRow of asArray(data.rows)) {
    const row = asRecord(rawRow)
    const url = str(row.url, 500)
    if (!url) continue
    const path = pagePath(url)
    const values: Record<string, Datum | null> = {}
    let any = false
    for (const column of columns) {
      const key =
        column === 'requests'
          ? `browser:${path}:${formFactor}:requests`
          : `lighthouse:${path}:${formFactor}:${LIGHTHOUSE_COLUMN_KEYS[column]}`
      const entry = r.catalogEntry(key)
      if (entry) {
        any = true
        r.usedEvidence.add(entry.evidenceId)
        values[column] = { label: column, value: entry.value, unit: entry.unit, metricKey: entry.key, evidenceId: entry.evidenceId }
      } else values[column] = null
    }
    if (any) rows.push({ url, label: str(row.label, 80), values })
    else r.issues.push(`page_performance: no ${formFactor} measurements for ${path}`)
  }
  return columns.length && rows.length ? { formFactor, columns, rows } : null
}

/** Spanning tree of the crawl (each page under the first page that linked to it), aggregated if large. */
export function buildSiteGraph(graph: LinkGraph, findings: FindingItem[], maxNodes = 40): Record<string, unknown> | null {
  if (graph.pages.length === 0) return null
  const byPath = new Map<string, { url: string; depth: number; title: string | null }>()
  for (const page of graph.pages) if (!byPath.has(pagePath(page.url))) byPath.set(pagePath(page.url), page)
  const findingsByPath = new Map<string, { count: number; max: Severity | null }>()
  for (const finding of findings) {
    for (const path of new Set(finding.affectedUrls.map(pagePath))) {
      const entry = findingsByPath.get(path) ?? { count: 0, max: null }
      entry.count++
      if (!entry.max || SEVERITY_RANK[finding.severity] < SEVERITY_RANK[entry.max]) entry.max = finding.severity
      findingsByPath.set(path, entry)
    }
  }
  const root = [...byPath.values()].sort((a, b) => a.depth - b.depth)[0]!
  const rootPath = pagePath(root.url)
  const parent = new Map<string, string>()
  const seen = new Set([rootPath])
  const queue = [rootPath]
  const children = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const from = pagePath(edge.from)
    const to = pagePath(edge.to)
    if (from === to || !byPath.has(to)) continue
    children.set(from, [...(children.get(from) ?? []), to])
  }
  while (queue.length) {
    const current = queue.shift()!
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      parent.set(child, current)
      queue.push(child)
    }
  }
  // Pages not reachable from the root's links (e.g. sitemap-only) hang off the root.
  for (const path of byPath.keys()) if (!seen.has(path)) parent.set(path, rootPath)

  type Node = { id: string; label: string; url?: string; depth: number; kind: 'page' | 'group'; pageCount?: number; findings: number; maxSeverity: Severity | null }
  const nodes: Node[] = []
  const edges: { from: string; to: string }[] = []
  const paths = [...byPath.keys()]
  const truncated = paths.length > maxNodes
  const labelFor = (path: string) => (path === '/' ? 'Home' : (path.split('/').filter(Boolean).pop() ?? path)).slice(0, 60)

  if (!truncated) {
    for (const path of paths) {
      const stats = findingsByPath.get(path)
      nodes.push({ id: path, label: labelFor(path), url: byPath.get(path)!.url, depth: path === rootPath ? 0 : path.split('/').filter(Boolean).length, kind: 'page', findings: stats?.count ?? 0, maxSeverity: stats?.max ?? null })
      const p = parent.get(path)
      if (p) edges.push({ from: p, to: path })
    }
  } else {
    // Aggregate by first path segment: keep the root and top-level pages, group the rest.
    const groups = new Map<string, string[]>()
    for (const path of paths) {
      if (path === rootPath) continue
      const segment = path.split('/').filter(Boolean)[0] ?? path
      groups.set(segment, [...(groups.get(segment) ?? []), path])
    }
    const rootStats = findingsByPath.get(rootPath)
    nodes.push({ id: rootPath, label: 'Home', url: root.url, depth: 0, kind: 'page', findings: rootStats?.count ?? 0, maxSeverity: rootStats?.max ?? null })
    for (const [segment, members] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, maxNodes - 1)) {
      let count = 0
      let max: Severity | null = null
      for (const m of members) {
        const s = findingsByPath.get(m)
        if (!s) continue
        count += s.count
        if (s.max && (!max || SEVERITY_RANK[s.max] < SEVERITY_RANK[max])) max = s.max
      }
      const single = members.length === 1
      const id = single ? members[0]! : `/${segment}/*`
      nodes.push({ id, label: single ? labelFor(members[0]!) : `/${segment}`, url: single ? byPath.get(members[0]!)!.url : undefined, depth: 1, kind: single ? 'page' : 'group', pageCount: single ? undefined : members.length, findings: count, maxSeverity: max })
      edges.push({ from: rootPath, to: id })
    }
  }
  return { nodes, edges, totalPages: paths.length, truncated }
}

/** Resolves and validates one planner spec into a storable artifact (or rejects it with reasons). */
export async function resolveArtifactSpec(spec: ArtifactSpec, ctx: ResolveContext): Promise<ResolveResult> {
  const r = new Resolver(ctx)
  const where = `${spec.type} "${spec.title}"`
  const data = asRecord(spec.data)
  let resolved: Record<string, unknown> | null = null

  switch (spec.type as ArtifactType) {
    case 'metric': {
      const item = r.datum(data.item, `${where}.item`)
      resolved = item ? { item, caption: str(data.caption) } : null
      break
    }
    case 'metric_group':
      resolved = { items: r.datumList(data.items, `${where}.items`) }
      break
    case 'comparison_bar':
    case 'bar_chart':
      resolved = {
        unit: unit(data.unit),
        lowerIsBetter: data.lowerIsBetter === true,
        ...(spec.type === 'bar_chart' ? { orientation: data.orientation === 'vertical' ? 'vertical' : 'horizontal' } : {}),
        items: r.datumList(data.items, `${where}.items`),
      }
      break
    case 'donut':
      resolved = { unit: unit(data.unit), items: r.datumList(data.items, `${where}.items`).filter((d) => d.value >= 0) }
      break
    case 'comparison_table': {
      const columns = asArray(data.columns).filter((c): c is string => typeof c === 'string')
      const rows = asArray(data.rows).map((row, i) => {
        const rec = asRecord(row)
        return { label: str(rec.label, 80) ?? `Row ${i + 1}`, values: asArray(rec.values).map((v, j) => (v === null ? null : r.datum(v, `${where}.rows[${i}][${j}]`))) }
      })
      resolved = { columns, rows: rows.filter((row) => row.values.some((v) => v !== null)) }
      break
    }
    case 'stacked_bar': {
      const segments = asArray(data.segments).filter((c): c is string => typeof c === 'string')
      const rows = asArray(data.rows).map((row, i) => {
        const rec = asRecord(row)
        return { label: str(rec.label, 80) ?? `Row ${i + 1}`, values: asArray(rec.values).map((v, j) => r.datum(v, `${where}.rows[${i}][${j}]`)) }
      })
      resolved = { segments, rows: rows.filter((row) => row.values.every((v) => v !== null)) }
      break
    }
    case 'heatmap': {
      const columns = asArray(data.columns).filter((c): c is string => typeof c === 'string')
      const rows = asArray(data.rows).map((row, i) => {
        const rec = asRecord(row)
        return { label: str(rec.label, 80) ?? `Row ${i + 1}`, values: asArray(rec.values).map((v, j) => (v === null ? null : r.datum(v, `${where}.rows[${i}][${j}]`))) }
      })
      resolved = { unit: unit(data.unit), columns, rows }
      break
    }
    case 'page_performance':
      resolved = buildPagePerformance(r, data)
      break
    case 'trend_metric':
    case 'line_chart': {
      const keys = spec.type === 'trend_metric' ? [str(data.metricKey, 80)] : asArray(data.series).map((s) => str(asRecord(s).metricKey, 80))
      const series = keys
        .map((key) => ctx.history?.series.find((s) => s.key === key))
        .filter((s): s is NonNullable<typeof s> => !!s && s.points.length >= MIN_TREND_POINTS)
      if (series.length === 0) {
        r.issues.push(`${where}: no history series with at least ${MIN_TREND_POINTS} real audits`)
        break
      }
      const points = (s: (typeof series)[number]) => s.points.map((p) => ({ x: p.at, value: p.value, auditId: p.auditId }))
      resolved =
        spec.type === 'trend_metric'
          ? { metricKey: series[0]!.key, label: series[0]!.label, unit: series[0]!.unit, lowerIsBetter: series[0]!.lowerIsBetter, points: points(series[0]!) }
          : { unit: series[0]!.unit, lowerIsBetter: series[0]!.lowerIsBetter, series: series.map((s) => ({ label: s.label, metricKey: s.key, points: points(s) })) }
      break
    }
    case 'matrix': {
      const columns = asArray(data.columns).filter((c): c is string => typeof c === 'string')
      const rows = asArray(data.rows).map((row, i) => {
        const rec = asRecord(row)
        return {
          label: str(rec.label, 80) ?? `Row ${i + 1}`,
          cells: asArray(rec.cells).map((cell, j) => {
            const c = asRecord(cell)
            const status = ['yes', 'no', 'partial', 'unknown', 'na'].includes(c.status as string) ? c.status : 'unknown'
            return { status, note: str(c.note, 160), evidenceId: r.validEvidenceRef(str(c.evidenceId, 20), `${where}.rows[${i}][${j}]`) }
          }),
        }
      })
      resolved = { columns, rows }
      break
    }
    case 'tracking_coverage': {
      const rows = asArray(data.rows).map((row, i) => {
        const rec = asRecord(row)
        const status = (v: unknown) => (['yes', 'no', 'partial', 'unknown', 'na'].includes(v as string) ? v : 'unknown')
        return {
          name: str(rec.name, 80) ?? `Item ${i + 1}`,
          kind: ['analytics', 'tag-manager', 'advertising', 'session-recording', 'conversion-channel', 'other'].includes(rec.kind as string) ? rec.kind : 'other',
          present: status(rec.present),
          eventObserved: status(rec.eventObserved),
          note: str(rec.note, 160),
          evidenceId: r.validEvidenceRef(str(rec.evidenceId, 20), `${where}.rows[${i}]`),
        }
      })
      resolved = { rows }
      break
    }
    case 'journey':
    case 'funnel': {
      const storedRef = spec.type === 'journey' ? str(data.journeyId, 10) : undefined
      if (storedRef) {
        // A stored journey: steps, statuses and evidence come from the validated journey, not the spec.
        const journey = r.ctx.journeys.find((j) => j.ref.toLowerCase() === storedRef.trim().toLowerCase())
        if (!journey) {
          r.issues.push(`${where}: journey ${storedRef} does not exist`)
          break
        }
        resolved = {
          journeyId: journey.ref,
          steps: journey.steps.slice(0, 10).map((step) => ({
            label: step.label.slice(0, 80),
            url: step.url ?? undefined,
            kind: step.kind,
            status: step.status === 'unverified' ? 'unknown' : step.status,
            note: step.note ? step.note.slice(0, 200) : undefined,
            evidenceId: r.validEvidenceRef(step.evidenceIds[0], `${where}.steps`),
          })),
        }
        break
      }
      const steps = asArray(data.steps).map((step, i) => {
        const s = asRecord(step)
        const base = {
          label: str(s.label, 80) ?? `Step ${i + 1}`,
          note: str(s.note, 200),
          evidenceId: r.validEvidenceRef(str(s.evidenceId, 20), `${where}.steps[${i}]`),
          findingId: r.validFindingRef(str(s.findingId, 10), `${where}.steps[${i}]`),
        }
        return spec.type === 'journey'
          ? { ...base, url: str(s.url, 500), kind: ['page', 'action', 'outcome'].includes(s.kind as string) ? s.kind : 'page', status: ['ok', 'friction', 'blocked', 'unknown'].includes(s.status as string) ? s.status : 'unknown' }
          : { ...base, friction: ['none', 'low', 'medium', 'high'].includes(s.friction as string) ? s.friction : 'low' }
      })
      resolved = { steps }
      break
    }
    case 'timeline': {
      const items = asArray(data.items).map((item, i) => {
        const t = asRecord(item)
        return {
          label: str(t.label, 140) ?? `Item ${i + 1}`,
          at: str(t.at, 40),
          kind: ['stage', 'event', 'finding', 'audit'].includes(t.kind as string) ? t.kind : 'event',
          status: ['ok', 'warning', 'error', 'neutral'].includes(t.status as string) ? t.status : 'neutral',
          note: str(t.note, 200),
        }
      })
      resolved = { items }
      break
    }
    case 'evidence_gallery': {
      const items: { evidenceId: string; caption: string; imagePath: string }[] = []
      for (const [i, raw] of asArray(data.items).entries()) {
        const rec = asRecord(raw)
        const image = await r.image(str(rec.evidenceId, 20), `${where}.items[${i}]`)
        if (image) items.push({ evidenceId: image.ref, caption: str(rec.caption, 200) ?? '', imagePath: image.path })
      }
      resolved = { items }
      break
    }
    case 'annotated_screenshot': {
      const image = await r.image(str(data.evidenceId, 20), where)
      if (!image) break
      const space = data.coordinateSpace === 'css-px' || data.coordinateSpace === 'image-px' ? data.coordinateSpace : 'fraction'
      const viewportWidth = typeof data.viewportWidth === 'number' && data.viewportWidth > 0 ? data.viewportWidth : null
      const scale = space === 'css-px' ? (viewportWidth ? image.width / viewportWidth : null) : 1
      if (space === 'css-px' && scale === null) {
        r.issues.push(`${where}: css-px coordinates need viewportWidth`)
        break
      }
      const regions = []
      for (const [i, raw] of asArray(data.regions).entries()) {
        const rec = asRecord(raw)
        const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN)
        let [x, y, w, h] = [n(rec.x), n(rec.y), n(rec.w ?? rec.width), n(rec.h ?? rec.height)]
        if (space !== 'fraction') {
          const s = scale ?? 1
          x = (x * s) / image.width
          w = (w * s) / image.width
          y = (y * s) / image.height
          h = (h * s) / image.height
        }
        if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || x >= 1 || y >= 1 || x + w <= 0 || y + h <= 0) {
          r.issues.push(`${where}.regions[${i}]: region lies outside the image`)
          continue
        }
        // Clip to the image so overlays never render off-canvas.
        const cx = Math.max(0, x)
        const cy = Math.max(0, y)
        const severity = ['critical', 'high', 'medium', 'low', 'info'].includes(rec.severity as string) ? rec.severity : undefined
        regions.push({
          x: round4(cx),
          y: round4(cy),
          w: round4(Math.min(1 - cx, w - (cx - x))),
          h: round4(Math.min(1 - cy, h - (cy - y))),
          marker: str(rec.marker, 3) ?? String(regions.length + 1),
          title: str(rec.title, 80) ?? `Point ${regions.length + 1}`,
          description: str(rec.description, 300) ?? '',
          severity,
          findingId: r.validFindingRef(str(rec.findingId, 10), `${where}.regions[${i}]`),
        })
      }
      resolved = { evidenceId: image.ref, imagePath: image.path, imageWidth: image.width, imageHeight: image.height, regions }
      break
    }
    case 'before_after': {
      const pairs = ctx.comparison?.screenshots ?? []
      const wantUrl = str(data.url, 500)
      const wantViewport = str(data.viewport, 20)
      const pair =
        pairs.find((p) => (!wantUrl || pagePath(wantUrl) === p.url) && (!wantViewport || p.viewport === wantViewport)) ?? pairs[0]
      if (!pair) {
        r.issues.push(`${where}: no comparable screenshots with a previous audit`)
        break
      }
      resolved = {
        url: pair.url,
        viewport: pair.viewport,
        caption: str(data.caption, 200),
        before: { auditId: pair.before.auditId, evidenceId: pair.before.evidenceRef, imagePath: pair.before.artifactPath, date: pair.before.date },
        after: { auditId: pair.after.auditId, evidenceId: pair.after.evidenceRef, imagePath: pair.after.artifactPath, date: pair.after.date },
      }
      r.usedEvidence.add(pair.after.evidenceRef)
      break
    }
    case 'site_graph':
      resolved = ctx.linkGraph ? buildSiteGraph(ctx.linkGraph, ctx.findings) : null
      if (!resolved) r.issues.push(`${where}: no crawl link graph is available for this audit`)
      break
    case 'tech_map':
      resolved = buildTechMap(ctx.summary)
      if (!resolved) r.issues.push(`${where}: no technologies were identified`)
      break
    case 'impact_effort':
      resolved = buildImpactEffort(ctx.summary)
      if (!resolved) r.issues.push(`${where}: fewer than two opportunities`)
      break
  }

  if (!resolved) {
    r.issues.push(`${where}: rejected (no grounded data)`)
    return { artifact: null, issues: r.issues }
  }
  const parsed = ARTIFACT_DATA_SCHEMAS[spec.type].safeParse(resolved)
  if (!parsed.success) {
    r.issues.push(`${where}: rejected — ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    return { artifact: null, issues: r.issues }
  }

  const evidenceRefs = [
    ...new Set([...spec.evidenceIds.map((e) => r.validEvidenceRef(e, where)).filter((e): e is string => !!e), ...r.usedEvidence]),
  ]
  const findingRefs = [...new Set(spec.findingIds.map((f) => r.validFindingRef(f, where)).filter((f): f is string => !!f))]
  // These types draw their data from audit records (crawl graph, opportunities, technologies, audit
  // history) rather than from individual evidence items.
  const systemProvenance = ['timeline', 'impact_effort', 'tech_map', 'site_graph', 'trend_metric', 'line_chart'].includes(spec.type)
  if (!systemProvenance && evidenceRefs.length === 0) {
    r.issues.push(`${where}: rejected — a factual visual needs at least one piece of evidence`)
    return { artifact: null, issues: r.issues }
  }
  return {
    artifact: {
      type: spec.type,
      title: spec.title.slice(0, 120),
      subtitle: spec.subtitle?.slice(0, 200) ?? null,
      question: spec.question.slice(0, 240),
      description: spec.description.slice(0, 600),
      evidenceRefs,
      findingRefs,
      category: spec.category,
      priority: spec.priority,
      placement: spec.placement,
      data: parsed.data as Record<string, unknown>,
      createdBy: 'planner',
    },
    issues: r.issues,
  }
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000

export function buildTechMap(summary: AuditSummary | null): Record<string, unknown> | null {
  const technologies = summary?.technologies ?? []
  if (technologies.length === 0) return null
  const groups = new Map<string, { name: string; confidence: number; evidenceId?: string }[]>()
  for (const tech of technologies) {
    const label = tech.category.trim() || 'Other'
    groups.set(label, [...(groups.get(label) ?? []), { name: tech.name.slice(0, 80), confidence: tech.confidence, evidenceId: tech.evidenceIds[0] }])
  }
  return {
    groups: [...groups.entries()].slice(0, 10).map(([label, items]) => ({ label: label.slice(0, 80), items: items.slice(0, 12) })),
  }
}

export function buildImpactEffort(summary: AuditSummary | null): Record<string, unknown> | null {
  const opportunities = summary?.opportunities ?? []
  if (opportunities.length < 2) return null
  return {
    items: opportunities.slice(0, 12).map((o) => ({ label: o.title.slice(0, 100), impact: o.impact, effort: o.effort, findingIds: o.relatedFindingIds })),
  }
}

/** Facts about which data-backed artifact types are possible for this audit (for the planner prompt). */
export function availableSystemData(ctx: Omit<ResolveContext, 'imageSize'>): string[] {
  const lines: string[] = []
  const lighthousePages = new Set(ctx.catalog.filter((c) => c.key.startsWith('lighthouse:') && c.key.endsWith(':performance')).map((c) => c.key.split(':').slice(1, 3).join(' ')))
  if (lighthousePages.size) lines.push(`page_performance: Lighthouse data for ${[...lighthousePages].join(', ')}`)
  else lines.push('page_performance: unavailable (no Lighthouse data)')
  lines.push(ctx.linkGraph ? `site_graph: available (${ctx.linkGraph.pages.length} crawled pages)` : 'site_graph: unavailable (no link graph for this audit)')
  lines.push(ctx.comparison?.screenshots.length ? `before_after: ${ctx.comparison.screenshots.length} comparable screenshot pair(s) with the previous audit (${ctx.comparison.screenshots.map((p) => `${p.url} ${p.viewport}`).join(', ')})` : 'before_after: unavailable (no previous audit with comparable screenshots)')
  const series = ctx.history?.series ?? []
  lines.push(series.length ? `trend_metric / line_chart metricKey options (real history): ${series.map((s) => `${s.key} (${s.points.length} audits)`).join(', ')}` : 'trend_metric / line_chart: unavailable (fewer than 2 audits of this site)')
  lines.push((ctx.summary?.technologies?.length ?? 0) > 0 ? `tech_map: ${ctx.summary!.technologies!.length} technologies` : 'tech_map: unavailable')
  lines.push((ctx.summary?.opportunities?.length ?? 0) >= 2 ? `impact_effort: ${ctx.summary!.opportunities!.length} opportunities` : 'impact_effort: unavailable')
  const kinds = new Set(ctx.evidence.map(evidenceKind))
  if (kinds.has('tracking')) lines.push('tracking_coverage: baseline tracking evidence exists (cite it)')
  lines.push(
    ctx.journeys.length
      ? `journey (stored, use { "journeyId" }): ${ctx.journeys.map((j) => `${j.ref}${j.isPrimary ? ' (primary)' : ''} "${j.name}" — ${j.steps.map((s) => s.label).join(' → ')}`).join('; ')}`
      : 'journey: no stored journeys for this audit',
  )
  return lines
}

/**
 * Deterministic artifact specs built only from measured data. Used when the planner is unavailable
 * (AI failure, older audits) so a report still has grounded visuals. Resolved by the same resolver.
 */
export function fallbackArtifactSpecs(ctx: Omit<ResolveContext, 'imageSize'>): ArtifactSpec[] {
  const specs: ArtifactSpec[] = []
  const base = { subtitle: undefined, findingIds: [] as string[], category: null }

  const key = (k: string) => ctx.catalog.find((c) => c.key === k)
  const start = startPagePath(ctx.catalog)
  const metrics = [
    [`lighthouse:${start}:mobile:performance`, 'Mobile performance'],
    [`lighthouse:${start}:mobile:lcp`, 'LCP (mobile)'],
    [`lighthouse:${start}:mobile:cls`, 'CLS (mobile)'],
    ['links:broken', 'Broken links/resources'],
    ['crawl:pages', 'Pages crawled'],
  ]
    .map(([k, label]) => (key(k!) ? { label: label!, metricKey: k!, value: 0 } : null))
    .filter((m): m is NonNullable<typeof m> => !!m)
  if (metrics.length >= 2) {
    specs.push({
      ...base,
      type: 'metric_group',
      title: 'Key measurements',
      question: 'What do the automated measurements say about the start page?',
      description: 'Lab measurements from the baseline inspection.',
      evidenceIds: [],
      priority: 2,
      placement: 'overview',
      data: { items: metrics },
    })
  }

  const lighthousePaths = [...new Set(ctx.catalog.filter((c) => /^lighthouse:.*:mobile:performance$/.test(c.key)).map((c) => c.key.split(':')[1]!))]
  if (lighthousePaths.length) {
    specs.push({
      ...base,
      type: 'page_performance',
      title: 'Page performance (mobile, lab)',
      question: 'How fast and accessible are the measured pages?',
      description: 'Lighthouse lab results under simulated mobile conditions.',
      evidenceIds: [],
      category: 'Performance',
      priority: 2,
      placement: 'report',
      data: {
        formFactor: 'mobile',
        columns: ['performance', 'lcp', 'cls', 'tbt', 'accessibility', 'seo'],
        rows: lighthousePaths.slice(0, 15).map((path) => ({ url: path })),
      },
    })
  }

  const tracking = ctx.evidence.find((e) => evidenceKind(e) === 'tracking')
  if (tracking) {
    const detected = Array.isArray(tracking.metadata.detected) ? (tracking.metadata.detected as { name?: string; category?: string }[]) : []
    const kindFor = (category: string | undefined) =>
      /tag manager/i.test(category ?? '') ? 'tag-manager' : /advertis/i.test(category ?? '') ? 'advertising' : /session/i.test(category ?? '') ? 'session-recording' : 'analytics'
    const sent = Array.isArray(tracking.metadata.eventsSent) ? (tracking.metadata.eventsSent as { tool?: string; event?: string }[]) : []
    const rows: Record<string, unknown>[] = detected.slice(0, 12).map((d) => {
      const events = sent.filter((e) => e.tool && d.name && (e.tool === d.name || d.name.startsWith(e.tool))).map((e) => e.event)
      return {
        name: d.name ?? 'Unknown',
        kind: kindFor(d.category),
        present: 'yes',
        // The baseline never interacts, so conversion events stay "not tested" even when page views were sent.
        eventObserved: 'unknown',
        note: events.length ? `Sent on page load: ${events.slice(0, 4).join(', ')}; conversion events not tested` : 'Conversion events not tested automatically',
        evidenceId: tracking.ref,
      }
    })
    const surface = ctx.evidence.find((e) => evidenceKind(e) === 'conversion-surface')
    if (surface && Array.isArray(surface.metadata.pages)) {
      const pages = surface.metadata.pages as { whatsappLinks?: unknown[]; telLinks?: number; mailtoLinks?: number; forms?: unknown[] }[]
      const channel = (name: string, present: boolean) => ({ name, kind: 'conversion-channel', present: present ? 'yes' : 'no', eventObserved: 'unknown', evidenceId: surface.ref })
      rows.push(channel('WhatsApp links', pages.some((p) => (p.whatsappLinks?.length ?? 0) > 0)))
      rows.push(channel('Phone (tel:) links', pages.some((p) => (p.telLinks ?? 0) > 0)))
      rows.push(channel('Email (mailto:) links', pages.some((p) => (p.mailtoLinks ?? 0) > 0)))
      rows.push(channel('Forms', pages.some((p) => (p.forms?.length ?? 0) > 0)))
    }
    if (rows.length) {
      specs.push({
        ...base,
        type: 'tracking_coverage',
        title: 'Tracking & conversion measurement',
        question: 'Which tools load, and can conversions be measured?',
        description: detected.length ? 'Tools observed on page load; conversion events were not verified automatically.' : 'No analytics or advertising tools were observed on page load.',
        evidenceIds: [tracking.ref],
        category: 'Tracking',
        priority: 2,
        placement: 'report',
        data: { rows },
      })
    }
  }

  if (ctx.linkGraph) {
    specs.push({ ...base, type: 'site_graph', title: 'Site structure', question: 'How are the crawled pages connected, and where do issues concentrate?', description: 'Pages placed under the page that first linked to them; colour shows the most severe finding on each page.', evidenceIds: [], priority: 4, placement: 'appendix', data: {} })
  }
  if ((ctx.summary?.opportunities?.length ?? 0) >= 2) {
    specs.push({ ...base, type: 'impact_effort', title: 'Impact vs effort', question: 'Which improvements give the most value for the effort?', description: 'Opportunities positioned by expected impact and implementation effort (qualitative).', evidenceIds: [], priority: 3, placement: 'report', data: {} })
  }
  if ((ctx.summary?.technologies?.length ?? 0) > 0) {
    specs.push({ ...base, type: 'tech_map', title: 'Technology stack', question: 'What is the site built and run with?', description: 'Technologies identified with confidence levels.', evidenceIds: [], priority: 5, placement: 'appendix', data: {} })
  }
  if (ctx.comparison?.screenshots.length) {
    specs.push({ ...base, type: 'before_after', title: 'Before / after', question: 'What does the page look like now compared with the previous audit?', description: 'Same page and viewport captured in both audits.', evidenceIds: [], priority: 3, placement: 'report', data: {} })
  }
  const perfSeries = ctx.history?.series.find((s) => s.key === 'lighthouse.performance')
  if (perfSeries) {
    specs.push({ ...base, type: 'trend_metric', title: 'Performance over time', question: 'Is mobile performance improving across audits?', description: 'Lighthouse mobile performance of the start page in each audit.', evidenceIds: [], category: 'Performance', priority: 3, placement: 'overview', data: { metricKey: perfSeries.key } })
  }
  return specs
}
