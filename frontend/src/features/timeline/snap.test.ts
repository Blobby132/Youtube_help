import { describe, expect, it } from 'vitest'
import { nearestPoint, snapEdges, snapPoints } from './snap'

const words = [
  { id: 'w1', text: 'Every', start: 0.3, end: 0.5 },
  { id: 'w2', text: 'airplane', start: 0.55, end: 1.1 },
]
const groups = [{ words, start: 0.3, end: 1.4 }]
const points = snapPoints({ words, groups, clipEdges: [3], playhead: 2, end: 8 })

describe('snapping', () => {
  it('collects words, captions, clips, the playhead and both ends, in time order', () => {
    expect(points.map((p) => `${p.kind}@${p.time}`)).toEqual([
      'edge@0',
      'caption@0.3',
      'word@0.3',
      'word@0.5',
      'word@0.55',
      'word@1.1',
      'caption@1.4',
      'playhead@2',
      'clip@3',
      'edge@8',
    ])
  })

  it('finds the nearest point within the threshold, preferring captions at the same time', () => {
    expect(nearestPoint(points, 0.53, 0.1)).toEqual({ time: 0.55, kind: 'word' })
    expect(nearestPoint(points, 0.33, 0.1)).toEqual({ time: 0.3, kind: 'caption' })
    expect(nearestPoint(points, 5, 0.1)).toBeNull()
  })

  it('lets the start of the video win over a word right at the start', () => {
    const early = snapPoints({ words: [{ id: 'w', text: 'Every', start: 0.07, end: 0.3 }], groups: [], clipEdges: [], playhead: 0, end: 5 })
    expect(nearestPoint(early, 0.06, 0.1)?.time).toBe(0)
    expect(early.some((p) => p.time === 0.07)).toBe(false)
    expect(early.some((p) => p.time === 0.3)).toBe(true)
  })

  it('snaps a moving clip by whichever edge is closest to a point', () => {
    // A clip proposed at 1.97-2.95: its start is 0.03 from the playhead at 2, its end 0.05
    // from the clip edge at 3. The start is closer.
    expect(snapEdges(points, [1.97, 2.95], 0.1)).toEqual({ shift: expect.closeTo(0.03), point: { time: 2, kind: 'playhead' } })
    expect(snapEdges(points, [1.9, 2.98], 0.1)).toEqual({ shift: expect.closeTo(0.02), point: { time: 3, kind: 'clip' } })
    expect(snapEdges(points, [4.0, 7.97], 0.1)).toEqual({ shift: expect.closeTo(0.03), point: { time: 8, kind: 'edge' } })
    expect(snapEdges(points, [4.5, 5.5], 0.1)).toEqual({ shift: 0, point: null })
  })
})
