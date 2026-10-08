import { describe, expect, it } from 'vitest'
import { createProject } from '../../state/project/defaults'
import type { TitleSettings } from '../../state/project/types'
import { LINE_HEIGHT } from '../preview/captionLayout'
import {
  hasTitle,
  layoutRank,
  layoutTitle,
  RANK_GAP,
  RANK_TOP,
  rankLabelSize,
  rankTop,
  splitWords,
  TITLE_BAR_PADDING,
  TITLE_TOP,
  titleShown,
} from './overlayLayout'

/** Every letter is 10 px wide and a space 10 px, so widths are easy to follow. */
function measured(text: string) {
  const words = splitWords(text)
  return { words, widths: words.map((word) => word.length * 10), spaceWidth: 10 }
}

const title = (patch: Partial<TitleSettings> = {}): TitleSettings => ({
  ...createProject().canvas.title,
  enabled: true,
  text: 'Top 5 weird facts',
  ...patch,
})

describe('title', () => {
  it('shows only when it is on and has text', () => {
    expect(hasTitle(title())).toBe(true)
    expect(hasTitle(title({ enabled: false }))).toBe(false)
    expect(hasTitle(title({ text: '   ' }))).toBe(false)
  })

  it('shows for the whole video, or for its first seconds', () => {
    expect(titleShown(title({ timing: 'full' }), 40)).toBe(true)
    expect(titleShown(title({ timing: 'intro', seconds: 3 }), 2.9)).toBe(true)
    expect(titleShown(title({ timing: 'intro', seconds: 3 }), 3)).toBe(false)
  })

  it('sits at the top, centred, inside a full-width bar', () => {
    const t = title({ fontSize: 100, bar: true })
    const layout = layoutTitle(measured('Top 5 weird facts'), t, 1080)
    const padding = 100 * TITLE_BAR_PADDING
    const lineHeight = 100 * LINE_HEIGHT
    expect(layout.lines).toEqual([{ text: 'Top 5 weird facts', x: (1080 - 170) / 2, y: TITLE_TOP + padding + lineHeight / 2 }])
    expect(layout.bar).toEqual({ top: TITLE_TOP, height: lineHeight + padding * 2 })
    expect(layout.bottom).toBe(TITLE_TOP + lineHeight + padding * 2)
  })

  it('wraps long titles; without a bar the text starts right at the top', () => {
    const long = 'word '.repeat(30)
    const layout = layoutTitle(measured(long), title({ fontSize: 80, bar: false }), 1080)
    expect(layout.bar).toBeNull()
    expect(layout.lines.length).toBeGreaterThan(1)
    expect(layout.lines[0].y).toBe(TITLE_TOP + (80 * LINE_HEIGHT) / 2)
    for (const line of layout.lines) expect(line.x).toBeGreaterThanOrEqual((1080 - 940) / 2)
  })
})

describe('ranking overlay', () => {
  const style = createProject().ranking.style

  it('goes under the title when there is one', () => {
    expect(rankTop(null)).toBe(RANK_TOP)
    expect(rankTop(400)).toBe(400 + RANK_GAP)
  })

  it('puts the big number first and the label under it', () => {
    const layout = layoutRank(measured('Boeing 747'), style, 300, 1080)
    expect(layout.numberY).toBe(300 + style.size / 2)
    expect(layout.label).toHaveLength(1)
    expect(layout.label[0].text).toBe('Boeing 747')
    expect(layout.label[0].y).toBeGreaterThan(300 + style.size)
    expect(layout.bottom).toBeCloseTo(300 + style.size * 1.05 + rankLabelSize(style) * LINE_HEIGHT)
  })

  it('has no label lines for an entry without a label', () => {
    expect(layoutRank(measured(''), style, 300, 1080).label).toEqual([])
  })
})
