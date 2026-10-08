// Draws the title and the ranking overlay onto the preview canvas, placed by
// ../canvas/overlayLayout.ts.
import { fontFamily } from '../../lib/fonts'
import type { RankEntry, RankStyle, TitleSettings } from '../../state/project/types'
import {
  layoutRank,
  layoutTitle,
  OUTLINE_SCALE,
  rankLabelSize,
  splitWords,
  type TextLine,
  type TitleLayout,
} from '../canvas/overlayLayout'

const font = (fontId: string, size: number) => `${size}px "${fontFamily(fontId)}", "Arial Black", sans-serif`

function measure(ctx: CanvasRenderingContext2D, text: string) {
  const words = splitWords(text)
  return { words, widths: words.map((word) => ctx.measureText(word).width), spaceWidth: ctx.measureText(' ').width }
}

function prepare(ctx: CanvasRenderingContext2D, fontId: string, size: number) {
  ctx.font = font(fontId, size)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
}

/** Text straight on the video: a dark outline and shadow underneath keep it readable. */
function drawOutlined(ctx: CanvasRenderingContext2D, lines: readonly TextLine[], size: number, color: string) {
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'
  ctx.shadowOffsetY = size * 0.06
  ctx.shadowBlur = size * 0.12
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = Math.max(4, size * OUTLINE_SCALE) * 2
  for (const line of lines) ctx.strokeText(line.text, line.x, line.y)
  ctx.restore()
  ctx.fillStyle = color
  for (const line of lines) ctx.fillText(line.text, line.x, line.y)
}

/** Measures and places the title (also needed when it isn't drawn, to place the ranking). */
export function measureTitle(ctx: CanvasRenderingContext2D, title: TitleSettings): TitleLayout {
  ctx.save()
  prepare(ctx, title.fontId, title.fontSize)
  const layout = layoutTitle(measure(ctx, title.text), title, ctx.canvas.width)
  ctx.restore()
  return layout
}

export function drawTitle(ctx: CanvasRenderingContext2D, title: TitleSettings, layout: TitleLayout) {
  ctx.save()
  prepare(ctx, title.fontId, title.fontSize)
  if (layout.bar) {
    ctx.fillStyle = title.barColor
    ctx.fillRect(0, layout.bar.top, ctx.canvas.width, layout.bar.height)
    ctx.fillStyle = title.color
    for (const line of layout.lines) ctx.fillText(line.text, line.x, line.y)
  } else {
    drawOutlined(ctx, layout.lines, title.fontSize, title.color)
  }
  ctx.restore()
}

/** The big rank number ("#3") with the entry's label under it, from `top` down. */
export function drawRank(ctx: CanvasRenderingContext2D, entry: RankEntry, rank: number, style: RankStyle, top: number) {
  const { width } = ctx.canvas
  const labelSize = rankLabelSize(style)
  ctx.save()
  prepare(ctx, style.fontId, labelSize)
  const layout = layoutRank(measure(ctx, entry.label), style, top, width)
  drawOutlined(ctx, layout.label, labelSize, style.labelColor)

  prepare(ctx, style.fontId, style.size)
  const text = `#${rank}`
  const x = (width - ctx.measureText(text).width) / 2
  drawOutlined(ctx, [{ text, x, y: layout.numberY }], style.size, style.numberColor)
  ctx.restore()
}
