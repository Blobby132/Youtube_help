// Where the title and the ranking overlay sit on the 1080x1920 frame. Like captionLayout.ts,
// these are the numbers the FFmpeg render (stage 6) places them with. Text is measured by
// the caller (with the bundled font), so the layout itself is plain arithmetic.
import type { RankStyle, TitleSettings } from '../../state/project/types'
import { LINE_HEIGHT, lineWidth, wrapLines } from '../preview/captionLayout'

/** Top of the title: below the part of the screen YouTube's own buttons cover. */
export const TITLE_TOP = 150
export const TITLE_MAX_WIDTH = 940
/** Space above and below the title text inside its bar, as a share of the font size. */
export const TITLE_BAR_PADDING = 0.4
/** Without a title the ranking starts here; with one, this far below the title. */
export const RANK_TOP = 220
export const RANK_GAP = 48
/** The label under the rank number, as a share of the number's size. */
export const RANK_LABEL_SCALE = 0.36
export const RANK_LABEL_MAX_WIDTH = 900
/** Outline around text drawn straight on the video, as a share of its size. */
export const OUTLINE_SCALE = 0.07

export interface TextLine {
  text: string
  /** Left edge (lines are centred). */
  x: number
  /** Vertical centre. */
  y: number
}

interface Measured {
  words: string[]
  widths: number[]
  spaceWidth: number
}

function centredLines({ words, widths, spaceWidth }: Measured, maxWidth: number, top: number, lineHeight: number, frameWidth: number): TextLine[] {
  return wrapLines(widths, spaceWidth, maxWidth).map((indices, row) => ({
    text: indices.map((i) => words[i]).join(' '),
    x: (frameWidth - lineWidth(indices, widths, spaceWidth)) / 2,
    y: top + lineHeight * (row + 0.5),
  }))
}

/** Splits text into the words the layout wraps. */
export const splitWords = (text: string) => text.trim().split(/\s+/).filter(Boolean)

export function hasTitle(title: TitleSettings): boolean {
  return title.enabled && splitWords(title.text).length > 0
}

/** Whether the title is on screen at `time`. */
export function titleShown(title: TitleSettings, time: number): boolean {
  return hasTitle(title) && (title.timing === 'full' || time < title.seconds)
}

export interface TitleLayout {
  lines: TextLine[]
  /** The bar behind the text, across the whole frame (null without a bar). */
  bar: { top: number; height: number } | null
  /** Where the title block ends. */
  bottom: number
}

export function layoutTitle(measured: Measured, title: TitleSettings, frameWidth: number): TitleLayout {
  const padding = title.bar ? title.fontSize * TITLE_BAR_PADDING : 0
  const lineHeight = title.fontSize * LINE_HEIGHT
  const lines = centredLines(measured, TITLE_MAX_WIDTH, TITLE_TOP + padding, lineHeight, frameWidth)
  const height = lines.length * lineHeight + padding * 2
  return { lines, bar: title.bar ? { top: TITLE_TOP, height } : null, bottom: TITLE_TOP + height }
}

/**
 * Where the ranking overlay starts: under the title when the video has one. A title shown
 * only at the start still keeps its place, so the ranking doesn't jump when it goes.
 */
export function rankTop(titleBottom: number | null): number {
  return titleBottom === null ? RANK_TOP : titleBottom + RANK_GAP
}

export const rankLabelSize = (style: RankStyle) => Math.round(style.size * RANK_LABEL_SCALE)

export interface RankLayout {
  /** Vertical centre of the rank number (horizontally centred). */
  numberY: number
  label: TextLine[]
  bottom: number
}

export function layoutRank(label: Measured, style: RankStyle, top: number, frameWidth: number): RankLayout {
  const labelSize = rankLabelSize(style)
  const lineHeight = labelSize * LINE_HEIGHT
  const labelTop = top + style.size * 1.05
  const lines = centredLines(label, RANK_LABEL_MAX_WIDTH, labelTop, lineHeight, frameWidth)
  return { numberY: top + style.size / 2, label: lines, bottom: labelTop + lines.length * lineHeight }
}
