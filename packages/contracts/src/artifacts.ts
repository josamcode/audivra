import { z } from 'zod'
import { Category, EffortLevel, Severity } from './enums.ts'

/**
 * Visual artifacts.
 *
 * The AI decides WHAT deserves a visual (an ArtifactSpec from the planner). Audivra decides HOW it is
 * rendered (trusted components) and WHERE every number comes from: numeric values are either resolved
 * from the deterministic metric catalog (`metricKey`) or must appear in the cited evidence. Specs that
 * cannot be grounded are rejected, never rendered.
 */

export const ARTIFACT_TYPES = [
  'metric',
  'metric_group',
  'comparison_bar',
  'comparison_table',
  'bar_chart',
  'stacked_bar',
  'donut',
  'line_chart',
  'trend_metric',
  'matrix',
  'heatmap',
  'tracking_coverage',
  'page_performance',
  'journey',
  'funnel',
  'site_graph',
  'timeline',
  'evidence_gallery',
  'annotated_screenshot',
  'before_after',
  'tech_map',
  'impact_effort',
] as const
export const ArtifactType = z.enum(ARTIFACT_TYPES)
export type ArtifactType = z.infer<typeof ArtifactType>

export const VALUE_UNITS = ['ms', 's', 'score', 'count', 'bytes', 'kb', 'percent', 'px', 'ratio', 'days', 'none'] as const
export const ValueUnit = z.enum(VALUE_UNITS)
export type ValueUnit = z.infer<typeof ValueUnit>

const finite = z.number().refine((n) => Number.isFinite(n), 'must be a finite number')

/**
 * A number shown in an artifact. After resolution every datum carries the evidence it came from:
 * `metricKey` values are filled from the metric catalog; literal values must be found in `evidenceId`.
 */
export const Datum = z.object({
  label: z.string().min(1).max(80),
  value: finite,
  unit: ValueUnit.default('none'),
  metricKey: z.string().optional(),
  evidenceId: z.string().optional(),
  tone: z.enum(['neutral', 'good', 'warning', 'bad']).optional(),
  note: z.string().max(200).optional(),
})
export type Datum = z.infer<typeof Datum>

export const CELL_STATUSES = ['yes', 'no', 'partial', 'unknown', 'na'] as const
export const CellStatus = z.enum(CELL_STATUSES)
export type CellStatus = z.infer<typeof CellStatus>

export const MatrixCell = z.object({
  status: CellStatus,
  note: z.string().max(160).optional(),
  evidenceId: z.string().optional(),
})
export type MatrixCell = z.infer<typeof MatrixCell>

const label = z.string().min(1).max(80)

export const MetricData = z.object({ item: Datum, caption: z.string().max(200).optional() })
export const MetricGroupData = z.object({ items: z.array(Datum).min(2).max(8) })
export const ComparisonBarData = z.object({
  unit: ValueUnit,
  lowerIsBetter: z.boolean().default(false),
  items: z.array(Datum).min(2).max(10),
})
export const ComparisonTableData = z
  .object({
    columns: z.array(label).min(2).max(5),
    rows: z.array(z.object({ label, values: z.array(Datum.nullable()) })).min(1).max(12),
  })
  .refine((d) => d.rows.every((r) => r.values.length === d.columns.length), 'each row needs one value per column')
export const BarChartData = z.object({
  unit: ValueUnit,
  lowerIsBetter: z.boolean().default(false),
  orientation: z.enum(['horizontal', 'vertical']).default('horizontal'),
  items: z.array(Datum).min(2).max(16),
})
export const StackedBarData = z
  .object({
    segments: z.array(label).min(2).max(6),
    rows: z.array(z.object({ label, values: z.array(Datum) })).min(1).max(12),
  })
  .refine((d) => d.rows.every((r) => r.values.length === d.segments.length), 'each row needs one value per segment')
export const DonutData = z.object({ unit: ValueUnit, items: z.array(Datum).min(2).max(6) })

export const HistoryPoint = z.object({
  x: z.string().describe('ISO date of the audit'),
  value: finite,
  auditId: z.string(),
})
export type HistoryPoint = z.infer<typeof HistoryPoint>

export const LineChartData = z.object({
  unit: ValueUnit,
  lowerIsBetter: z.boolean().default(false),
  series: z.array(z.object({ label, metricKey: z.string(), points: z.array(HistoryPoint).min(2) })).min(1).max(4),
})
export const TrendMetricData = z.object({
  metricKey: z.string(),
  label,
  unit: ValueUnit,
  lowerIsBetter: z.boolean(),
  points: z.array(HistoryPoint).min(2),
})
export const MatrixData = z
  .object({
    columns: z.array(label).min(1).max(8),
    rows: z.array(z.object({ label, cells: z.array(MatrixCell) })).min(1).max(20),
  })
  .refine((d) => d.rows.every((r) => r.cells.length === d.columns.length), 'each row needs one cell per column')
export const HeatmapData = z
  .object({
    unit: ValueUnit,
    columns: z.array(label).min(2).max(10),
    rows: z.array(z.object({ label, values: z.array(Datum.nullable()) })).min(2).max(20),
  })
  .refine((d) => d.rows.every((r) => r.values.length === d.columns.length), 'each row needs one value per column')

export const TRACKING_KINDS = [
  'analytics',
  'tag-manager',
  'advertising',
  'session-recording',
  'conversion-channel',
  'other',
] as const
export const TrackingCoverageData = z.object({
  rows: z
    .array(
      z.object({
        name: label,
        kind: z.enum(TRACKING_KINDS),
        present: CellStatus,
        eventObserved: CellStatus,
        note: z.string().max(160).optional(),
        evidenceId: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
})

export const PAGE_PERFORMANCE_COLUMNS = [
  'performance',
  'lcp',
  'fcp',
  'cls',
  'tbt',
  'accessibility',
  'seo',
  'bestPractices',
  'weight',
  'requests',
] as const
export const PagePerformanceData = z.object({
  formFactor: z.enum(['mobile', 'desktop']),
  columns: z.array(z.enum(PAGE_PERFORMANCE_COLUMNS)).min(1).max(7),
  rows: z
    .array(
      z.object({
        url: z.string(),
        label: z.string().max(80).optional(),
        values: z.record(z.string(), Datum.nullable()),
      }),
    )
    .min(1)
    .max(15),
})

export const JourneyData = z.object({
  /** Set when the journey is a stored journey of the audit (J*); its steps come from that journey. */
  journeyId: z.string().optional(),
  steps: z
    .array(
      z.object({
        label,
        url: z.string().optional(),
        kind: z.enum(['page', 'action', 'outcome']),
        status: z.enum(['ok', 'friction', 'blocked', 'unknown']),
        note: z.string().max(200).optional(),
        evidenceId: z.string().optional(),
        findingId: z.string().optional(),
      }),
    )
    .min(2)
    .max(10),
})
export const FunnelData = z.object({
  steps: z
    .array(
      z.object({
        label,
        friction: z.enum(['none', 'low', 'medium', 'high']),
        note: z.string().max(200).optional(),
        evidenceId: z.string().optional(),
        findingId: z.string().optional(),
      }),
    )
    .min(2)
    .max(8),
})
export const SiteGraphData = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().max(80),
        url: z.string().optional(),
        depth: z.number().int().min(0),
        kind: z.enum(['page', 'group']),
        pageCount: z.number().int().min(1).optional(),
        findings: z.number().int().min(0),
        maxSeverity: Severity.nullable(),
      }),
    )
    .min(1)
    .max(60),
  edges: z.array(z.object({ from: z.string(), to: z.string() })).max(160),
  totalPages: z.number().int().min(0),
  truncated: z.boolean(),
})
export const TimelineData = z.object({
  items: z
    .array(
      z.object({
        label: z.string().max(140),
        at: z.string().optional(),
        kind: z.enum(['stage', 'event', 'finding', 'audit']),
        status: z.enum(['ok', 'warning', 'error', 'neutral']).default('neutral'),
        note: z.string().max(200).optional(),
      }),
    )
    .min(2)
    .max(30),
})
export const EvidenceGalleryData = z.object({
  items: z
    .array(
      z.object({
        evidenceId: z.string(),
        caption: z.string().max(200),
        imagePath: z.string().optional(),
      }),
    )
    .min(1)
    .max(12),
})
export const AnnotationRegion = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
    marker: z.string().min(1).max(3).describe('Short marker shown on the image, e.g. "1".'),
    title: z.string().min(1).max(80),
    description: z.string().max(300),
    severity: Severity.optional(),
    findingId: z.string().optional(),
  })
  .refine((r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, 'region must lie inside the image')
export type AnnotationRegion = z.infer<typeof AnnotationRegion>
export const AnnotatedScreenshotData = z.object({
  evidenceId: z.string(),
  imagePath: z.string().optional(),
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
  regions: z.array(AnnotationRegion).min(1).max(8),
})
const SnapshotImage = z.object({
  auditId: z.string(),
  evidenceId: z.string(),
  imagePath: z.string(),
  date: z.string(),
})
export const BeforeAfterData = z.object({
  url: z.string(),
  viewport: z.string(),
  caption: z.string().max(200).optional(),
  before: SnapshotImage,
  after: SnapshotImage,
})
export const TechMapData = z.object({
  groups: z
    .array(
      z.object({
        label,
        items: z
          .array(z.object({ name: z.string().max(80), confidence: z.number().min(0).max(1), evidenceId: z.string().optional() }))
          .min(1)
          .max(12),
      }),
    )
    .min(1)
    .max(10),
})
export const ImpactEffortData = z.object({
  items: z
    .array(
      z.object({
        label: z.string().max(100),
        impact: z.enum(['high', 'medium', 'low']),
        effort: EffortLevel,
        findingIds: z.array(z.string()),
      }),
    )
    .min(2)
    .max(12),
})

export const ARTIFACT_DATA_SCHEMAS = {
  metric: MetricData,
  metric_group: MetricGroupData,
  comparison_bar: ComparisonBarData,
  comparison_table: ComparisonTableData,
  bar_chart: BarChartData,
  stacked_bar: StackedBarData,
  donut: DonutData,
  line_chart: LineChartData,
  trend_metric: TrendMetricData,
  matrix: MatrixData,
  heatmap: HeatmapData,
  tracking_coverage: TrackingCoverageData,
  page_performance: PagePerformanceData,
  journey: JourneyData,
  funnel: FunnelData,
  site_graph: SiteGraphData,
  timeline: TimelineData,
  evidence_gallery: EvidenceGalleryData,
  annotated_screenshot: AnnotatedScreenshotData,
  before_after: BeforeAfterData,
  tech_map: TechMapData,
  impact_effort: ImpactEffortData,
} as const satisfies Record<ArtifactType, z.ZodType>

export type ArtifactDataMap = { [K in ArtifactType]: z.infer<(typeof ARTIFACT_DATA_SCHEMAS)[K]> }

export const ARTIFACT_PLACEMENTS = ['overview', 'report', 'appendix'] as const
export const ArtifactPlacement = z.enum(ARTIFACT_PLACEMENTS)
export type ArtifactPlacement = z.infer<typeof ArtifactPlacement>

const envelope = {
  id: z.string(),
  ref: z.string().describe('Per-audit reference, e.g. "A3".'),
  auditId: z.string(),
  title: z.string().min(3).max(120),
  subtitle: z.string().max(200).nullable(),
  question: z.string().max(240).describe('The question this artifact answers.'),
  description: z.string().max(600),
  evidenceIds: z.array(z.string()),
  findingIds: z.array(z.string()),
  category: Category.nullable(),
  priority: z.number().int().min(1).max(5),
  placement: ArtifactPlacement,
  createdBy: z.enum(['planner', 'system']),
  createdAt: z.string(),
}

function variant<T extends ArtifactType>(type: T) {
  return z.object({ ...envelope, type: z.literal(type), data: ARTIFACT_DATA_SCHEMAS[type] })
}

/** A validated, fully resolved artifact as stored and rendered. */
export const Artifact = z.discriminatedUnion('type', [
  variant('metric'),
  variant('metric_group'),
  variant('comparison_bar'),
  variant('comparison_table'),
  variant('bar_chart'),
  variant('stacked_bar'),
  variant('donut'),
  variant('line_chart'),
  variant('trend_metric'),
  variant('matrix'),
  variant('heatmap'),
  variant('tracking_coverage'),
  variant('page_performance'),
  variant('journey'),
  variant('funnel'),
  variant('site_graph'),
  variant('timeline'),
  variant('evidence_gallery'),
  variant('annotated_screenshot'),
  variant('before_after'),
  variant('tech_map'),
  variant('impact_effort'),
])
export type Artifact = z.infer<typeof Artifact>
export type ArtifactOf<T extends ArtifactType> = Extract<Artifact, { type: T }>

/**
 * What the Artifact Planner returns. `data` is checked per type after the CLI's JSON-schema pass,
 * then resolved (metric keys → catalog values, images → evidence files) and verified.
 */
export const ArtifactSpec = z.object({
  type: ArtifactType,
  title: z.string().min(3).max(120),
  subtitle: z.string().max(200).optional(),
  question: z.string().min(5).max(240).describe('The concrete question this visual answers for the reader.'),
  description: z.string().max(600).describe('One or two sentences explaining what the visual shows.'),
  evidenceIds: z.array(z.string()).describe('Evidence (EV-*) supporting the visual. Required for factual claims.'),
  findingIds: z.array(z.string()).describe('Final findings (F*) the visual supports.'),
  category: Category.nullable(),
  priority: z.number().int().min(1).max(5).describe('1 = most important.'),
  placement: ArtifactPlacement,
  data: z.record(z.string(), z.unknown()).describe('Type-specific data; see the planner instructions.'),
})
export type ArtifactSpec = z.infer<typeof ArtifactSpec>

export const ArtifactPlan = z.object({
  artifacts: z.array(ArtifactSpec).max(12),
  keptAsText: z
    .array(z.object({ insight: z.string(), reason: z.string() }))
    .describe('Important insights deliberately left as text, with the reason.'),
})
export type ArtifactPlan = z.infer<typeof ArtifactPlan>

/** Deterministic, measured facts the planner can reference by key instead of writing numbers. */
export const MetricCatalogEntry = z.object({
  key: z.string(),
  label: z.string(),
  value: finite,
  unit: ValueUnit,
  url: z.string().nullable(),
  evidenceId: z.string(),
  group: z.string(),
  lowerIsBetter: z.boolean().nullable(),
})
export type MetricCatalogEntry = z.infer<typeof MetricCatalogEntry>
