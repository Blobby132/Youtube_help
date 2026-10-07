import { describe, expect, it } from 'vitest'
import { coverRect, cropAxis } from './cover'

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
