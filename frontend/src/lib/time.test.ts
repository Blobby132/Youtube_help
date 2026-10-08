import { describe, expect, it } from 'vitest'
import { formatTimecode, parseTimecode } from './time'

describe('parseTimecode', () => {
  it('reads minutes and seconds the way formatTimecode shows them', () => {
    expect(parseTimecode('0:03.04')).toBe(3.04)
    expect(parseTimecode('1:15')).toBe(75)
    expect(parseTimecode('1:15.45')).toBeCloseTo(75.45)
    expect(parseTimecode(formatTimecode(75.45))).toBeCloseTo(75.45)
  })

  it('reads plain seconds, with a point or a comma, and ignores spaces and a trailing s', () => {
    expect(parseTimecode('3.04')).toBe(3.04)
    expect(parseTimecode('3')).toBe(3)
    expect(parseTimecode('75')).toBe(75)
    expect(parseTimecode('.5')).toBe(0.5)
    expect(parseTimecode('3,04')).toBe(3.04)
    expect(parseTimecode('  3.04 s ')).toBe(3.04)
    expect(parseTimecode('3.04S')).toBe(3.04)
  })

  it('says null for anything else', () => {
    for (const text of ['', ' ', 'abc', '-1', '1:', ':05', '1:75', '1.2.3', '3 4', '1:02:03', '3m'])
      expect(parseTimecode(text), text).toBeNull()
  })
})
