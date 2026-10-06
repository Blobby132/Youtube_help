import { describe, expect, it } from 'vitest'
import { CAPTION_CENTER, CAPTION_MAX_WIDTH, layoutWords } from './captionLayout'

const frame = { width: 1080, height: 1920 }

describe('layoutWords', () => {
  it('centres a single line on the chosen position', () => {
    const placed = layoutWords(['HELLO', 'THERE'], [200, 220], 30, 96, frame, 'middle')
    expect(placed.map((p) => p.y)).toEqual([960, 960])
    const total = 200 + 30 + 220
    expect(placed[0].x).toBe((1080 - total) / 2)
    expect(placed[1].x).toBe((1080 - total) / 2 + 230)
  })

  it('wraps words that do not fit and keeps the block centred', () => {
    const placed = layoutWords(['ONE', 'TWO', 'THREE'], [500, 380, 300], 20, 100, frame, 'bottom')
    const rows = [...new Set(placed.map((p) => p.y))]
    expect(rows).toHaveLength(2)
    const centre = frame.height * CAPTION_CENTER.bottom
    expect((rows[0] + rows[1]) / 2).toBeCloseTo(centre)
    // first row: 500 + 20 + 380 = 900 fits exactly
    expect(placed[1].y).toBe(placed[0].y)
    expect(500 + 20 + 380).toBeLessThanOrEqual(CAPTION_MAX_WIDTH)
  })

  it('never wraps a lone long word onto an empty line', () => {
    const placed = layoutWords(['SUPERCALIFRAGILISTIC'], [1200], 20, 100, frame, 'top')
    expect(placed).toHaveLength(1)
    expect(placed[0].x).toBe(-60)
  })
})
