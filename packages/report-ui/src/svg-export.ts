import type { Datum, ValueUnit } from '@audivra/contracts'
import { approxTextWidth, formatValue, truncateToWidth } from './format.ts'
import { segmentColor, type ChartPalette } from './theme.ts'

/*
 * String builders for standalone SVG exports of HTML-rendered chart types (bars, stacked bars,
 * heatmaps). Concrete colors (EXPORT_PALETTE) so the files render anywhere, not just in browsers.
 */

export function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c)
}

function header(width: number, height: number, title: string, palette: ChartPalette): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(title)}">` +
    `<title>${escapeXml(title)}</title>` +
    `<rect width="${width}" height="${height}" fill="${palette.bg}"/>`
  )
}

function text(
  x: number,
  y: number,
  content: string,
  palette: ChartPalette,
  options: { anchor?: 'start' | 'middle' | 'end'; size?: number; color?: string; mono?: boolean; weight?: number } = {},
): string {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${options.anchor ?? 'start'}" font-family="${escapeXml(
    options.mono ? palette.fontMono : palette.fontSans,
  )}" font-size="${options.size ?? 12}" font-weight="${options.weight ?? 400}" fill="${options.color ?? palette.fg}">${escapeXml(content)}</text>`
}

function toneColor(palette: ChartPalette, datum: Datum): string {
  const tone = datum.tone ?? 'neutral'
  return tone === 'neutral' ? palette.accent : palette.tone[tone]
}

export function barsSvg(
  title: string,
  items: Datum[],
  unit: ValueUnit,
  palette: ChartPalette,
  lowerIsBetter = false,
): string {
  const width = 640
  const rowH = 26
  const top = 34
  const labelW = 200
  const valueW = 80
  const barX = 16 + labelW + 8
  const barW = width - barX - valueW - 16
  const height = top + items.length * rowH + (lowerIsBetter ? 26 : 12)
  const max = Math.max(0, ...items.map((i) => Math.abs(i.value)))
  let out = header(width, height, title, palette)
  out += text(16, 20, title, palette, { size: 13, weight: 600 })
  items.forEach((item, index) => {
    const y = top + index * rowH
    const w = max > 0 ? (Math.abs(item.value) / max) * barW : 0
    out += text(16, y + 13, truncateToWidth(item.label, labelW, 12), palette, { size: 12 })
    out += `<rect x="${barX}" y="${y + 4}" width="${barW}" height="10" rx="4" fill="${palette.bgMuted}"/>`
    out += `<rect x="${barX}" y="${y + 4}" width="${Math.max(0, w).toFixed(1)}" height="10" rx="4" fill="${toneColor(palette, item)}"/>`
    out += text(width - 16, y + 13, formatValue(item.value, item.unit ?? unit), palette, {
      anchor: 'end',
      size: 12,
      mono: true,
      color: item.tone && item.tone !== 'neutral' ? palette.tone[item.tone] : palette.fg,
    })
  })
  if (lowerIsBetter) out += text(16, height - 10, 'Lower is better', palette, { size: 11, color: palette.subtle })
  return `${out}</svg>`
}

export function stackedSvg(
  title: string,
  segments: string[],
  rows: { label: string; values: Datum[] }[],
  palette: ChartPalette,
): string {
  const width = 640
  const rowH = 26
  const legendY = 40
  const top = 64
  const labelW = 180
  const valueW = 70
  const barX = 16 + labelW + 8
  const barW = width - barX - valueW - 16
  const totals = rows.map((r) => r.values.reduce((s, v) => s + Math.max(0, v.value), 0))
  const max = Math.max(0, ...totals)
  const unit = rows[0]?.values[0]?.unit ?? 'none'
  const height = top + rows.length * rowH + 12
  let out = header(width, height, title, palette)
  out += text(16, 20, title, palette, { size: 13, weight: 600 })
  let lx = 16
  segments.forEach((segment, index) => {
    out += `<rect x="${lx}" y="${legendY - 9}" width="10" height="10" rx="2" fill="${segmentColor(palette, segment, index)}"/>`
    out += text(lx + 14, legendY, segment, palette, { size: 11, color: palette.muted })
    lx += 14 + approxTextWidth(segment, 11) + 16
  })
  rows.forEach((row, rowIndex) => {
    const y = top + rowIndex * rowH
    out += text(16, y + 13, truncateToWidth(row.label, labelW, 12), palette, { size: 12 })
    out += `<rect x="${barX}" y="${y + 3}" width="${barW}" height="12" rx="4" fill="${palette.bgMuted}"/>`
    let x = barX
    row.values.forEach((value, index) => {
      const w = max > 0 ? (Math.max(0, value.value) / max) * barW : 0
      if (w > 0) {
        out += `<rect x="${x.toFixed(1)}" y="${y + 3}" width="${w.toFixed(1)}" height="12" fill="${segmentColor(palette, segments[index] ?? '', index)}"/>`
        x += w
      }
    })
    out += text(width - 16, y + 13, formatValue(totals[rowIndex] ?? 0, unit), palette, { anchor: 'end', size: 12, mono: true })
  })
  return `${out}</svg>`
}

export function heatmapSvg(
  title: string,
  columns: string[],
  rows: { label: string; values: (Datum | null)[] }[],
  unit: ValueUnit,
  palette: ChartPalette,
): string {
  const labelW = 170
  const cellW = Math.max(56, Math.min(96, Math.floor((640 - labelW - 32) / Math.max(1, columns.length))))
  const cellH = 26
  const top = 58
  const width = 16 + labelW + columns.length * cellW + 16
  const height = top + rows.length * cellH + 12
  const max = Math.max(0, ...rows.flatMap((r) => r.values.map((v) => (v ? Math.abs(v.value) : 0))))
  let out = header(width, height, title, palette)
  out += text(16, 20, title, palette, { size: 13, weight: 600 })
  columns.forEach((column, index) => {
    out += text(16 + labelW + index * cellW + cellW / 2, top - 10, truncateToWidth(column, cellW - 4, 11), palette, {
      anchor: 'middle',
      size: 11,
      color: palette.muted,
    })
  })
  rows.forEach((row, rowIndex) => {
    const y = top + rowIndex * cellH
    out += text(16, y + 17, truncateToWidth(row.label, labelW - 8, 12), palette, { size: 12 })
    row.values.forEach((value, index) => {
      const x = 16 + labelW + index * cellW
      const opacity = value && max > 0 ? 0.08 + (Math.abs(value.value) / max) * 0.5 : 0
      out += `<rect x="${x + 1}" y="${y + 1}" width="${cellW - 2}" height="${cellH - 2}" rx="3" fill="${palette.accent}" fill-opacity="${opacity.toFixed(2)}" stroke="${palette.border}"/>`
      out += text(x + cellW / 2, y + 17, value ? formatValue(value.value, value.unit ?? unit) : '–', palette, {
        anchor: 'middle',
        size: 11,
        mono: true,
      })
    })
  })
  return `${out}</svg>`
}
