import { describe, expect, it } from 'vitest'
import { createProject } from '../../state/project/defaults'
import { overlayScene } from '../preview/frameOverlays'
import { frameTime, overlayRuns } from './overlayFrames'

function project() {
  const p = createProject()
  p.canvas.title = { ...p.canvas.title, enabled: true, text: 'Top 2', timing: 'intro', seconds: 0.3 }
  p.captions.style.wordsPerCaption = 2
  p.captions.words = [
    { id: 'a', text: 'Hello', start: 0.1, end: 0.4 },
    { id: 'b', text: 'world.', start: 0.4, end: 0.8 },
  ]
  p.ranking.entries = [
    { id: 'r1', label: 'First', time: { start: 0.5, end: 1.0 } },
    { id: 'r2', label: 'No time yet', time: null },
  ]
  return p
}

describe('overlayRuns', () => {
  it('splits the video where the title, rank, caption or spoken word changes, at frame times', () => {
    const runs = overlayRuns(overlayScene(project()), 45, { num: 30, den: 1 })
    const summary = runs.map((r) => [r.first, r.end, r.state.title, r.state.rank?.rank ?? null, r.state.caption?.active ?? null])
    expect(summary).toEqual([
      [0, 3, true, null, null], // title only, until the first word at 0.1 s (frame 3)
      [3, 9, true, null, 0], // "Hello" highlighted; the title goes at 0.3 s (frame 9)
      [9, 12, false, null, 0],
      [12, 15, false, null, 1], // "world." from 0.4 s
      [15, 30, false, 2, 1], // #2 (counting down, 2 entries) from 0.5 s; the caption holds until 1.05 s
      [30, 32, false, null, 1],
    ])
    // Each run is drawn at its first frame's time.
    expect(runs[3].time).toBeCloseTo(frameTime(12, { num: 30, den: 1 }))
  })

  it('uses the render frame rate, including NTSC rates', () => {
    const runs = overlayRuns(overlayScene(project()), 30, { num: 30000, den: 1001 })
    // 0.1 s is between frames 2 (0.0667 s) and 3 (0.1001 s).
    expect(runs[1].first).toBe(3)
  })

  it('leaves out frames without any text', () => {
    const p = createProject()
    expect(overlayRuns(overlayScene(p), 90, { num: 30, den: 1 })).toEqual([])
  })
})
