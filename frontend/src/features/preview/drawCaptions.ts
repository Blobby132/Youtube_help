// Draws the caption showing at a given time onto the preview canvas.
import { fontFamily } from '../../lib/fonts'
import type { CaptionStyle } from '../../state/project/types'
import { activeWordIndex, type CaptionGroup, displayWord } from '../captions/captionGroups'
import { layoutWords } from './captionLayout'

export function drawCaption(ctx: CanvasRenderingContext2D, group: CaptionGroup, time: number, style: CaptionStyle) {
  const { width, height } = ctx.canvas
  const size = style.fontSize
  ctx.save()
  ctx.font = `${size}px "${fontFamily(style.fontId)}", "Arial Black", sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  const texts = group.words.map((word) => displayWord(word.text, style.uppercase))
  const widths = texts.map((text) => ctx.measureText(text).width)
  const placed = layoutWords(texts, widths, ctx.measureText(' ').width, size, { width, height }, style.position)
  // With one word per caption every word is "the spoken word", so the plain text colour is used.
  const active = group.words.length > 1 ? activeWordIndex(group, time) : -1

  // 1. Shadow and outline underneath, 2. the letters on top.
  if (style.shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'
    ctx.shadowOffsetY = size * 0.06
    ctx.shadowBlur = size * 0.12
  }
  if (style.outlineWidth > 0) {
    ctx.strokeStyle = style.outlineColor
    ctx.lineWidth = style.outlineWidth * 2
    for (const word of placed) ctx.strokeText(word.text, word.x, word.y)
    ctx.shadowColor = 'transparent'
  }
  for (const word of placed) {
    ctx.fillStyle = word.index === active ? style.highlightColor : style.color
    ctx.fillText(word.text, word.x, word.y)
  }
  ctx.restore()
}
