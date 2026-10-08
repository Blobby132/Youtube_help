import { describe, expect, it } from 'vitest'
import { clipCropAxis, coverRect, cropAxis, insideRect } from './cover'

describe('coverRect', () => {
  it('crops a landscape clip to a 9:16 slice, positioned by cropX', () => {
    // 1920x1080 filled to 1920 high: shows 607.5 of its 1920 pixels' width.
    const centre = coverRect(1920, 1080, 1080, 1920, 0.5, 0.5)
    expect(centre.sw).toBeCloseTo(607.5)
    expect(centre.sh).toBeCloseTo(1080)
    expect(centre.sx).toBeCloseTo((1920 - 607.5) / 2)
    expect(coverRect(1920, 1080, 1080, 1920, 0, 0.5).sx).toBe(0)
    expect(coverRect(1920, 1080, 1080, 1920, 1, 0.5).sx).toBeCloseTo(1920 - 607.5)
    expect(centre.sy).toBe(0)
  })

  it('crops the top and bottom of a clip taller than 9:16 (e.g. 448x832 AI clips)', () => {
    const rect = coverRect(448, 832, 1080, 1920, 0.5, 0)
    expect(rect.sw).toBeCloseTo(448)
    expect(rect.sh).toBeCloseTo(448 * (1920 / 1080))
    expect(rect.sy).toBe(0)
    expect(rect.scale).toBeCloseTo(448 / 1080)
  })

  it('shows all of a 9:16 clip', () => {
    expect(coverRect(1080, 1920, 1080, 1920, 0.2, 0.9)).toEqual({ sx: 0, sy: 0, sw: 1080, sh: 1920, scale: 1 })
  })

  it('knows which way a clip can be panned', () => {
    expect(cropAxis(1920, 1080, 1080, 1920)).toBe('x')
    expect(cropAxis(448, 832, 1080, 1920)).toBe('y')
    expect(cropAxis(720, 1280, 1080, 1920)).toBeNull()
  })
})

describe('Fit inside', () => {
  it('shows a landscape clip whole, full width and centred top to bottom', () => {
    const rect = insideRect(1920, 1080, 1080, 1920)
    expect(rect.width).toBeCloseTo(1080)
    expect(rect.height).toBeCloseTo(607.5)
    expect(rect.x).toBeCloseTo(0)
    expect(rect.y).toBeCloseTo((1920 - 607.5) / 2)
  })

  it('shows a square clip full width, and a very tall one full height', () => {
    expect(insideRect(500, 500, 1080, 1920)).toEqual({ x: 0, y: 420, width: 1080, height: 1080 })
    const tall = insideRect(400, 1000, 1080, 1920)
    expect(tall.height).toBeCloseTo(1920)
    expect(tall.width).toBeCloseTo(768)
    expect(tall.x).toBeCloseTo(156)
  })

  it('has nothing to crop', () => {
    expect(clipCropAxis('inside', 1920, 1080, 1080, 1920)).toBeNull()
    expect(clipCropAxis('fill', 1920, 1080, 1080, 1920)).toBe('x')
  })
})
