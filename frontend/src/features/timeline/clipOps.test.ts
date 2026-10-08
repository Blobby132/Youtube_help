import { describe, expect, it } from 'vitest'
import type { TimelineClip } from '../../state/project/types'
import {
  appendClip,
  clipAt,
  DEFAULT_CLIP_SECONDS,
  findGaps,
  fitToVoiceover,
  insertClip,
  MIN_CLIP,
  moveClip,
  newClip,
  setSpeed,
  splitClip,
  trimEnd,
  trimStart,
  type SourceLength,
} from './clipOps'

const clip = (id: string, start: number, duration: number, extra: Partial<TimelineClip> = {}): TimelineClip => ({
  ...newClip(id, `m-${id}`, start, duration),
  ...extra,
})

/** "id@start-end" for each clip, in timeline order. */
const layout = (clips: readonly TimelineClip[]) =>
  [...clips].sort((a, b) => a.start - b.start).map((c) => `${c.id}@${+c.start.toFixed(3)}-${+(c.start + c.duration).toFixed(3)}`)

// Every source is 10 s long unless listed; "img" media are images.
const lengths: Record<string, number | null> = { 'm-short': 3, 'm-img': null }
const sourceLength: SourceLength = (mediaId) => (mediaId in lengths ? lengths[mediaId] : 10)

describe('gaps', () => {
  it('lists the empty stretches up to the end of the voiceover', () => {
    const clips = [clip('a', 1, 2), clip('b', 3, 1), clip('c', 6, 2)]
    expect(findGaps(clips, 10)).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 6 },
      { start: 8, end: 10 },
    ])
    expect(findGaps([], 5)).toEqual([{ start: 0, end: 5 }])
    expect(findGaps([clip('a', 0, 12)], 10)).toEqual([])
  })

  it('finds the clip at a time (the cut belongs to the clip that starts there)', () => {
    const clips = [clip('a', 0, 2), clip('b', 2, 2)]
    expect(clipAt(clips, 1)?.id).toBe('a')
    expect(clipAt(clips, 2)?.id).toBe('b')
    expect(clipAt(clips, 4)).toBeUndefined()
  })
})

describe('adding clips', () => {
  const media = { id: 'm-new', duration: 10 }

  it('dropped in a gap, fills the rest of the gap', () => {
    const clips = insertClip([clip('a', 0, 2), clip('b', 6, 2)], media, 3, 10, 'n')
    expect(layout(clips)).toEqual(['a@0-2', 'n@3-6', 'b@6-8'])
  })

  it('is no longer than its footage', () => {
    const clips = insertClip([], { id: 'm-short', duration: 3 }, 1, 10, 'n')
    expect(layout(clips)).toEqual(['n@1-4'])
  })

  it('past the end takes a few seconds', () => {
    expect(layout(insertClip([clip('a', 0, 5)], media, 5, 5, 'n'))).toEqual(['a@0-5', `n@5-${5 + DEFAULT_CLIP_SECONDS}`])
    expect(layout(insertClip([], { id: 'm-img', duration: null }, 0, 0, 'n'))).toEqual([`n@0-${DEFAULT_CLIP_SECONDS}`])
  })

  it('dropped on a clip goes before or after it and pushes later clips only as far as needed', () => {
    const clips = [clip('a', 0, 2), clip('b', 2, 2), clip('c', 8, 2)]
    // Right half of "a": after it. b moves to 6; c (at 8) already has room.
    expect(layout(insertClip(clips, media, 1.5, 10, 'n'))).toEqual(['a@0-2', 'n@2-6', 'b@6-8', 'c@8-10'])
    // Left half of "b": before it.
    expect(layout(insertClip(clips, media, 2.5, 10, 'n'))).toEqual(['a@0-2', 'n@2-6', 'b@6-8', 'c@8-10'])
    // A longer push carries on through touching clips.
    const tight = [clip('a', 0, 2), clip('b', 2, 2), clip('c', 4, 2)]
    expect(layout(insertClip(tight, media, 0.5, 10, 'n'))).toEqual(['n@0-4', 'a@4-6', 'b@6-8', 'c@8-10'])
  })

  it('"Add to timeline" fills the first gap, or goes after the last clip', () => {
    expect(layout(appendClip([clip('a', 2, 2)], media, 10, 'n'))).toEqual(['n@0-2', 'a@2-4'])
    expect(layout(appendClip([clip('a', 0, 10)], media, 10, 'n'))).toEqual(['a@0-10', `n@10-${10 + DEFAULT_CLIP_SECONDS}`])
  })

  it('starts muted, centred and at normal speed', () => {
    const [added] = insertClip([], media, 0, 5, 'n')
    expect(added).toMatchObject({ inPoint: 0, speed: 1, cropX: 0.5, cropY: 0.5, fit: 'fill', keepAudio: false })
  })
})

describe('moving clips', () => {
  const clips = [clip('a', 0, 2), clip('b', 2, 3), clip('c', 5, 1), clip('d', 9, 1)]

  it('goes where it is dragged when there is room', () => {
    expect(layout(moveClip(clips, 'c', 6.5, 7))).toEqual(['a@0-2', 'b@2-5', 'c@6.5-7.5', 'd@9-10'])
  })

  it('slides as close as it can when the mouse is over a big enough gap', () => {
    // c (1 s) dragged so it would overlap d, mouse still in the gap 6..9.
    expect(layout(moveClip(clips, 'c', 8.5, 8.8))).toEqual(['a@0-2', 'b@2-5', 'c@8-9', 'd@9-10'])
  })

  it('dropped on another clip, trades places and keeps the outer cuts', () => {
    // a dragged onto the right half of b: b moves to the start, a follows it.
    expect(layout(moveClip(clips, 'a', 3.5, 4))).toEqual(['b@0-3', 'a@3-5', 'c@5-6', 'd@9-10'])
    // c dragged onto the left half of a: everything up to c's end shifts, d stays.
    expect(layout(moveClip(clips, 'c', 0, 0.4))).toEqual(['c@0-1', 'a@1-3', 'b@3-6', 'd@9-10'])
  })

  it('keeps gaps inside the stretch it reorders', () => {
    const spaced = [clip('a', 0, 2), clip('b', 3, 2)]
    // gap of 1 s between them stays between the first and second clip
    expect(layout(moveClip(spaced, 'b', 0, 0.5))).toEqual(['b@0-2', 'a@3-5'])
  })

  it('stays put when dropped back where it was', () => {
    expect(layout(moveClip(clips, 'b', 1.5, 3))).toEqual(layout(clips))
  })

  it('never goes before 0 or overlaps', () => {
    const moved = moveClip(clips, 'd', -3, 8)
    expect(layout(moved)).toContain('d@6-7')
    for (const c of moved) for (const o of moved) if (c !== o) expect(c.start + c.duration <= o.start + 1e-6 || c.start >= o.start + o.duration - 1e-6).toBe(true)
  })
})

describe('trimming', () => {
  it('the start edge shows more or less of the beginning, up to the footage it has', () => {
    const clips = [clip('a', 0, 2), clip('b', 4, 2, { inPoint: 1 })]
    expect(trimStart(clips, 'b', 4.5, sourceLength)[1]).toMatchObject({ start: 4.5, duration: 1.5, inPoint: 1.5 })
    // 1 s of footage before its in-point, and clip a ends at 2.
    expect(trimStart(clips, 'b', 0, sourceLength)[1]).toMatchObject({ start: 3, duration: 3, inPoint: 0 })
    const touching = [clip('a', 0, 2), clip('b', 2.5, 2, { inPoint: 5 })]
    expect(trimStart(touching, 'b', 1, sourceLength)[1]).toMatchObject({ start: 2, inPoint: 4.5 })
  })

  it('the end edge stops at the next clip and at the end of the footage', () => {
    const clips = [clip('a', 0, 2, { inPoint: 7 }), clip('b', 6, 2)]
    expect(trimEnd(clips, 'a', 5, sourceLength)[0].duration).toBe(3) // 10 s source, from 7 s
    expect(trimEnd(clips, 'a', 1, sourceLength)[0].duration).toBe(1)
    const free = [clip('a', 0, 2), clip('b', 6, 2)]
    expect(trimEnd(free, 'a', 9, sourceLength)[0].duration).toBe(6)
  })

  it('keeps clips at least MIN_CLIP long', () => {
    expect(trimEnd([clip('a', 0, 2)], 'a', -5, sourceLength)[0].duration).toBe(MIN_CLIP)
    expect(trimStart([clip('a', 0, 2)], 'a', 5, sourceLength)[0]).toMatchObject({ start: 2 - MIN_CLIP })
  })

  it('images can be as long as you like; slowed clips use footage more slowly', () => {
    expect(trimEnd([clip('img', 0, 2)], 'img', 60, sourceLength)[0].duration).toBe(60)
    const slow = [clip('a', 0, 2, { speed: 0.5 })]
    expect(trimEnd(slow, 'a', 30, sourceLength)[0].duration).toBe(20)
  })
})

describe('split, speed', () => {
  it('splits at the playhead into two clips that continue the footage', () => {
    const result = splitClip([clip('a', 1, 4, { inPoint: 2, speed: 2 })], 'a', 2, 'a2')!
    expect(layout(result)).toEqual(['a@1-2', 'a2@2-5'])
    expect(result[1].inPoint).toBe(4)
    expect(splitClip([clip('a', 1, 4)], 'a', 1.05, 'x')).toBeNull()
  })

  it('both halves of a split keep the crop and "Fit inside"', () => {
    const result = splitClip([clip('a', 0, 4, { fit: 'inside', cropX: 0.2 })], 'a', 2, 'a2')!
    expect(result.map((c) => [c.fit, c.cropX])).toEqual([
      ['inside', 0.2],
      ['inside', 0.2],
    ])
  })

  it('slowing a clip makes it longer, up to the next clip', () => {
    const clips = [clip('a', 0, 2), clip('b', 3, 2)]
    expect(setSpeed(clips, 'a', 0.5, sourceLength)[0]).toMatchObject({ speed: 0.5, duration: 3 })
    expect(setSpeed(clips, 'b', 2, sourceLength)[1]).toMatchObject({ speed: 2, duration: 1 })
  })
})

describe('fit to voiceover', () => {
  it('closes gaps by running each clip until the next one starts, keeping the cuts', () => {
    const clips = [clip('a', 0.5, 2), clip('b', 4, 2), clip('c', 7, 1)]
    const { clips: fitted, removed, slowed, gapsLeft } = fitToVoiceover(clips, 10, sourceLength)
    expect(layout(fitted)).toEqual(['a@0-4', 'b@4-7', 'c@7-10'])
    expect({ removed, slowed, gapsLeft }).toEqual({ removed: 0, slowed: 0, gapsLeft: 0 })
    expect(findGaps(fitted, 10)).toEqual([])
  })

  it('cuts clips at the end and removes those that start after it', () => {
    const { clips: fitted, removed } = fitToVoiceover([clip('a', 0, 6), clip('b', 6, 6), clip('c', 12, 2)], 8, sourceLength)
    expect(layout(fitted)).toEqual(['a@0-6', 'b@6-8'])
    expect(removed).toBe(1)
  })

  it('uses earlier footage, then slows a clip down, when it runs out', () => {
    // m-short has 3 s. Starting 2 s in, it has 1 s left but needs 2 s: start 1 s in instead.
    const early = fitToVoiceover([clip('short', 0, 1, { inPoint: 2 })], 2, sourceLength)
    expect(early.clips[0]).toMatchObject({ start: 0, duration: 2, inPoint: 1, speed: 1 })
    // Needs 6 s from a 3 s clip: half speed.
    const slow = fitToVoiceover([clip('short', 0, 3)], 6, sourceLength)
    expect(slow.clips[0]).toMatchObject({ duration: 6, inPoint: 0, speed: 0.5 })
    expect(slow.slowed).toBe(1)
    // 30 s from 3 s would be slower than quarter speed: 12 s, and a gap is left.
    const capped = fitToVoiceover([clip('short', 0, 3)], 30, sourceLength)
    expect(capped.clips[0]).toMatchObject({ duration: 12, speed: 0.25 })
    expect(capped.gapsLeft).toBe(1)
  })

  it('stretches images to any length', () => {
    expect(fitToVoiceover([clip('img', 3, 1)], 9, sourceLength).clips[0]).toMatchObject({ start: 0, duration: 9 })
  })
})
