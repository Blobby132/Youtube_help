// Video-track editing as pure functions: (clips, ...) -> new clips. Kept free of React so
// every rule here is unit tested (clipOps.test.ts).
//
// Rules: clips sit at their own start time, never overlap, and gaps between them stay empty
// (shown as gaps). A clip can't use more footage than its source has; images have no limit.
import { CLIP_DEFAULTS } from '../../state/project/defaults'
import type { TimelineClip } from '../../state/project/types'

/** Shortest clip, in seconds. */
export const MIN_CLIP = 0.2
export const MIN_SPEED = 0.25
export const MAX_SPEED = 4
/** Length of a new image clip, and the most a new video clip takes when there's no gap to fill. */
export const DEFAULT_CLIP_SECONDS = 4

const EPS = 1e-6

/** Source length of a clip's media in seconds: null for images (any length), undefined if unknown. */
export type SourceLength = (mediaId: string) => number | null | undefined

export const clipEnd = (clip: TimelineClip) => clip.start + clip.duration

export const sortClips = (clips: readonly TimelineClip[]) => [...clips].sort((a, b) => a.start - b.start)

/** End of the last clip (0 without clips). */
export const clipsEnd = (clips: readonly TimelineClip[]) => clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0)

export const clipAt = (clips: readonly TimelineClip[], time: number) =>
  clips.find((clip) => time >= clip.start - EPS && time < clipEnd(clip) - EPS)

/** Longest a clip starting at `inPoint` can be on the timeline. */
export function maxDuration(inPoint: number, speed: number, sourceLength: number | null | undefined): number {
  return sourceLength == null ? Infinity : Math.max(0, (sourceLength - inPoint) / speed)
}

export interface Span {
  start: number
  end: number
}

/** Empty stretches of the video (0 to `end`) with no clip. */
export function findGaps(clips: readonly TimelineClip[], end: number, minLength = 0.01): Span[] {
  const gaps: Span[] = []
  let cursor = 0
  for (const clip of sortClips(clips)) {
    if (clip.start - cursor >= minLength && cursor < end) gaps.push({ start: cursor, end: Math.min(clip.start, end) })
    cursor = Math.max(cursor, clipEnd(clip))
  }
  if (end - cursor >= minLength) gaps.push({ start: cursor, end })
  return gaps.filter((gap) => gap.end - gap.start >= minLength)
}

/** Free stretches between `others` (the last one is open-ended). */
function freeSpans(others: readonly TimelineClip[]): Span[] {
  const spans: Span[] = []
  let cursor = 0
  for (const clip of sortClips(others)) {
    if (clip.start > cursor + EPS) spans.push({ start: cursor, end: clip.start })
    cursor = Math.max(cursor, clipEnd(clip))
  }
  spans.push({ start: cursor, end: Infinity })
  return spans
}

const fits = (others: readonly TimelineClip[], start: number, duration: number) =>
  start >= -EPS && others.every((o) => start + duration <= o.start + EPS || start >= clipEnd(o) - EPS)

function round(clip: TimelineClip): TimelineClip {
  const r = (n: number) => Math.round(n * 1e4) / 1e4
  return { ...clip, start: r(clip.start), duration: r(clip.duration), inPoint: r(clip.inPoint) }
}

export function newClip(id: string, mediaId: string, start: number, duration: number): TimelineClip {
  return round({ id, mediaId, start, duration, ...CLIP_DEFAULTS })
}

/**
 * Adds a clip of the media at `at` (e.g. where it was dropped).
 * - In a gap: starts at `at` and fills the rest of the gap, as far as its footage goes.
 * - On a clip: goes right before it (if dropped on its left half) or right after it, and
 *   the clips after it move later just enough to make room (a gap further on absorbs it).
 * - Past the end: starts at `at` with up to DEFAULT_CLIP_SECONDS.
 * `end` is the video's length (the voiceover's end).
 */
export function insertClip(
  clips: readonly TimelineClip[],
  media: { id: string; duration: number | null },
  at: number,
  end: number,
  id: string,
): TimelineClip[] {
  const sorted = sortClips(clips)
  const sourceMax = media.duration ?? Infinity
  const time = Math.max(0, at)
  const target = clipAt(sorted, time)

  if (!target) {
    const nextStart = sorted.find((c) => c.start >= time - EPS)?.start ?? Infinity
    const room = Math.min(nextStart, time < end - MIN_CLIP ? end : Infinity) - time
    const wanted = Number.isFinite(room) ? Math.min(sourceMax, room) : Math.min(sourceMax, DEFAULT_CLIP_SECONDS)
    if (wanted >= MIN_CLIP - EPS) return sortClips([...sorted, newClip(id, media.id, time, wanted)])
    // Too small a gap: fall through and insert next to the clip that follows.
  }

  const anchor = target ?? sorted.find((c) => c.start >= time - EPS)
  if (!anchor) return sortClips([...sorted, newClip(id, media.id, time, Math.max(MIN_CLIP, Math.min(sourceMax, DEFAULT_CLIP_SECONDS)))])
  const before = !target || time < anchor.start + anchor.duration / 2
  const start = before ? anchor.start : clipEnd(anchor)
  const length = Math.min(sourceMax, DEFAULT_CLIP_SECONDS)
  const added = newClip(id, media.id, start, length)
  // Push later clips along, stopping as soon as one already starts after the previous end.
  const result: TimelineClip[] = []
  let pushTo = start + length
  for (const clip of sorted) {
    if (clip.start < start - EPS || (clip.id === anchor.id && !before)) {
      result.push(clip)
      continue
    }
    if (clip.start < pushTo - EPS) {
      const moved = round({ ...clip, start: pushTo })
      result.push(moved)
      pushTo = clipEnd(moved)
    } else {
      result.push(clip)
      pushTo = -Infinity
    }
  }
  return sortClips([...result, added])
}

/** Where "Add to timeline" puts a clip: the first gap, or after the last clip. */
export function appendClip(
  clips: readonly TimelineClip[],
  media: { id: string; duration: number | null },
  end: number,
  id: string,
): TimelineClip[] {
  const gap = findGaps(clips, end, MIN_CLIP)[0]
  return insertClip(clips, media, gap ? gap.start : clipsEnd(clips), end, id)
}

/**
 * Drags a clip. `proposedStart` is where the drag would put it (already snapped) and
 * `pointer` the time under the mouse.
 * - If it fits there, it goes there.
 * - If the mouse is over a gap big enough for it, it slides as close as it can.
 * - Otherwise it changes places in the order: dropped on another clip's left half it goes
 *   before that clip, on the right half after it. The clips in between move over to make
 *   room; the first start and last end of that stretch (and everything else) stay put.
 */
export function moveClip(clips: readonly TimelineClip[], id: string, proposedStart: number, pointer: number): TimelineClip[] {
  const sorted = sortClips(clips)
  const from = sorted.findIndex((c) => c.id === id)
  if (from < 0) return sorted
  const clip = sorted[from]
  const others = sorted.filter((c) => c.id !== id)

  const start = Math.max(0, proposedStart)
  if (fits(others, start, clip.duration)) return sortClips([...others, round({ ...clip, start })])

  const span = freeSpans(others).find((s) => pointer >= s.start - EPS && pointer <= s.end + EPS)
  if (span && span.end - span.start >= clip.duration - EPS) {
    const clamped = Math.min(Math.max(start, span.start), span.end - clip.duration)
    return sortClips([...others, round({ ...clip, start: clamped })])
  }

  const to = others.filter((o) => o.start + o.duration / 2 < pointer).length
  return to === from ? sorted : reorder(sorted, from, to)
}

/** Moves sorted[from] to index `to`, re-laying out the clips between (see moveClip). */
export function reorder(sorted: readonly TimelineClip[], from: number, to: number): TimelineClip[] {
  const order = [...sorted]
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)
  const a = Math.min(from, to)
  const b = Math.max(from, to)
  const gaps = sorted.slice(a, b).map((clip, k) => Math.max(0, sorted[a + k + 1].start - clipEnd(clip)))
  let cursor = sorted[a].start
  for (let k = a; k <= b; k++) {
    order[k] = round({ ...order[k], start: cursor })
    cursor += order[k].duration + (k < b ? gaps[k - a] : 0)
  }
  return order
}

/** Drags a clip's left edge: its end stays put and it shows more or less of its beginning. */
export function trimStart(
  clips: readonly TimelineClip[],
  id: string,
  proposedStart: number,
  sourceLength: SourceLength,
): TimelineClip[] {
  return clips.map((clip) => {
    if (clip.id !== id) return clip
    const end = clipEnd(clip)
    const previousEnd = clips.filter((c) => c.id !== id && clipEnd(c) <= clip.start + EPS).reduce((e, c) => Math.max(e, clipEnd(c)), 0)
    const footageStart = sourceLength(clip.mediaId) === null ? -Infinity : clip.start - clip.inPoint / clip.speed
    const start = Math.min(Math.max(proposedStart, previousEnd, footageStart), end - MIN_CLIP)
    return round({ ...clip, start, duration: end - start, inPoint: Math.max(0, clip.inPoint + (start - clip.start) * clip.speed) })
  })
}

/** Drags a clip's right edge: its start stays put. */
export function trimEnd(clips: readonly TimelineClip[], id: string, proposedEnd: number, sourceLength: SourceLength): TimelineClip[] {
  return clips.map((clip) => {
    if (clip.id !== id) return clip
    const nextStart = clips.filter((c) => c.id !== id && c.start >= clipEnd(clip) - EPS).reduce((s, c) => Math.min(s, c.start), Infinity)
    const longest = clip.start + maxDuration(clip.inPoint, clip.speed, sourceLength(clip.mediaId))
    const end = Math.max(Math.min(proposedEnd, nextStart, longest), clip.start + MIN_CLIP)
    return round({ ...clip, duration: end - clip.start })
  })
}

/** Cuts a clip in two at `time`; null when that's too close to either end. */
export function splitClip(clips: readonly TimelineClip[], id: string, time: number, newId: string): TimelineClip[] | null {
  const clip = clips.find((c) => c.id === id)
  if (!clip || time < clip.start + MIN_CLIP - EPS || time > clipEnd(clip) - MIN_CLIP + EPS) return null
  const left = round({ ...clip, duration: time - clip.start })
  const right = round({
    ...clip,
    id: newId,
    start: time,
    duration: clipEnd(clip) - time,
    inPoint: clip.inPoint + (time - clip.start) * clip.speed,
  })
  return sortClips([...clips.filter((c) => c.id !== id), left, right])
}

export const removeClip = (clips: readonly TimelineClip[], id: string) => clips.filter((c) => c.id !== id)

/** Changes speed, keeping the clip's start and the footage it starts on. */
export function setSpeed(clips: readonly TimelineClip[], id: string, speed: number, sourceLength: SourceLength): TimelineClip[] {
  const sorted = sortClips(clips)
  return sorted.map((clip, index) => {
    if (clip.id !== id) return clip
    const next = sorted[index + 1]?.start ?? Infinity
    const footage = clip.duration * clip.speed
    const wanted = footage / speed
    const duration = Math.max(MIN_CLIP, Math.min(wanted, next - clip.start, maxDuration(clip.inPoint, speed, sourceLength(clip.mediaId))))
    return round({ ...clip, speed, duration })
  })
}

export interface FitResult {
  clips: TimelineClip[]
  /** Clips that started after the voiceover ends. */
  removed: number
  /** Clips slowed down because they had too little footage for their stretch. */
  slowed: number
  /** Gaps that remain because even a quarter-speed clip was too short. */
  gapsLeft: number
}

/**
 * "Fit to voiceover": makes the clips cover the whole voiceover (0 to `end`) with no gaps.
 * Every clip keeps its start (so cuts stay on the words they were placed on), except the
 * first, which starts at 0; each clip then runs until the next one starts, and the last
 * until the end. Clips that start after the end are removed. A clip without enough footage
 * for its stretch first uses earlier footage, then plays slower (down to quarter speed).
 */
export function fitToVoiceover(clips: readonly TimelineClip[], end: number, sourceLength: SourceLength): FitResult {
  const sorted = sortClips(clips)
  const kept = sorted.filter((clip) => clip.start < end - MIN_CLIP)
  let slowed = 0
  let gapsLeft = 0
  const fitted = kept.map((clip, index) => {
    const start = index === 0 ? 0 : clip.start
    const stop = index + 1 < kept.length ? kept[index + 1].start : end
    const length = stop - start
    let inPoint = Math.max(0, clip.inPoint - (clip.start - start) * clip.speed)
    let speed = clip.speed
    let duration = length
    const source = sourceLength(clip.mediaId)
    if (source != null && inPoint + length * speed > source + EPS) {
      inPoint = Math.max(0, source - length * speed)
      if (source < length * speed - EPS) {
        inPoint = 0
        speed = Math.max(MIN_SPEED, source / length)
        duration = Math.min(length, source / speed)
        slowed++
        if (duration < length - EPS) gapsLeft++
      }
    }
    return round({ ...clip, start, duration, inPoint, speed: Math.round(speed * 1000) / 1000 })
  })
  return { clips: fitted, removed: sorted.length - kept.length, slowed, gapsLeft }
}

/**
 * Puts a clip of the media exactly over `start`..`end` (a scene's footage), in place of what's
 * there: clips inside are removed, a clip across an edge is trimmed to the outside part, and one
 * across both edges keeps both outside parts (the right one as `splitId`). Footage shorter than
 * the stretch plays slower, down to quarter speed, as with Fit to voiceover.
 */
export function placeClip(
  clips: readonly TimelineClip[],
  media: { id: string; duration: number | null },
  start: number,
  end: number,
  id: string,
  splitId: string,
): TimelineClip[] {
  const result: TimelineClip[] = []
  for (const clip of sortClips(clips)) {
    if (clipEnd(clip) <= start + EPS || clip.start >= end - EPS) {
      result.push(clip)
      continue
    }
    const before = clip.start < start - EPS
    if (before && start - clip.start >= MIN_CLIP - EPS) result.push(round({ ...clip, duration: start - clip.start }))
    if (clipEnd(clip) > end + EPS && clipEnd(clip) - end >= MIN_CLIP - EPS) {
      const inPoint = clip.inPoint + (end - clip.start) * clip.speed
      result.push(round({ ...clip, id: before ? splitId : clip.id, start: end, duration: clipEnd(clip) - end, inPoint }))
    }
  }
  const length = end - start
  let speed = 1
  let duration = length
  if (media.duration != null && media.duration < length - EPS) {
    speed = Math.max(MIN_SPEED, Math.floor((media.duration / length) * 1000) / 1000)
    duration = Math.min(length, media.duration / speed)
  }
  return sortClips([...result, { ...newClip(id, media.id, start, duration), speed }])
}
