// Where and how captions sit on the 1080x1920 frame. Shared numbers so the FFmpeg render
// (stage 6) can place text the same way.
import type { CaptionPosition } from '../../state/project/types'

/** Vertical centre of the caption block, as a share of the frame height. */
export const CAPTION_CENTER: Record<CaptionPosition, number> = { top: 0.25, middle: 0.5, bottom: 0.72 }
/** Captions wrap inside this width (frame is 1080 wide). */
export const CAPTION_MAX_WIDTH = 900
export const LINE_HEIGHT = 1.15

export interface PlacedWord {
  index: number
  text: string
  x: number
  /** Vertical centre of the word's line. */
  y: number
}

/** Greedy word wrap, each line centred. `widths[i]` is the measured width of word i. */
export function layoutWords(
  texts: string[],
  widths: number[],
  spaceWidth: number,
  fontSize: number,
  frame: { width: number; height: number },
  position: CaptionPosition,
): PlacedWord[] {
  const lines: number[][] = []
  let line: number[] = []
  let lineWidth = 0
  texts.forEach((_, i) => {
    const extra = line.length ? spaceWidth + widths[i] : widths[i]
    if (line.length && lineWidth + extra > CAPTION_MAX_WIDTH) {
      lines.push(line)
      line = []
      lineWidth = 0
    }
    lineWidth += line.length ? spaceWidth + widths[i] : widths[i]
    line.push(i)
  })
  if (line.length) lines.push(line)

  const lineHeight = fontSize * LINE_HEIGHT
  const top = frame.height * CAPTION_CENTER[position] - (lines.length * lineHeight) / 2
  const placed: PlacedWord[] = []
  lines.forEach((indices, row) => {
    const width = indices.reduce((sum, i, k) => sum + widths[i] + (k ? spaceWidth : 0), 0)
    let x = (frame.width - width) / 2
    const y = top + lineHeight * (row + 0.5)
    for (const i of indices) {
      placed.push({ index: i, text: texts[i], x, y })
      x += widths[i] + spaceWidth
    }
  })
  return placed
}
