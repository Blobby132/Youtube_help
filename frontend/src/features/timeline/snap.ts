// Snapping clip edges to the voiceover: word starts and ends, caption changes, other clips,
// the playhead, and the start and end of the video.
import type { CaptionWord } from '../../state/project/types'
import type { CaptionGroup } from '../captions/captionGroups'

export type SnapKind = 'word' | 'caption' | 'clip' | 'playhead' | 'edge'

export interface SnapPoint {
  time: number
  kind: SnapKind
}

/** How close (in pixels) an edge must come to a snap point to jump to it. */
export const SNAP_PIXELS = 8
/** Words starting this close to 0 don't compete with the start of the video, so the first
 * clip isn't left with a few black frames before it. */
export const START_ZONE = 0.25

// When two points are at the same time, the more meaningful one is reported.
const PRIORITY: Record<SnapKind, number> = { caption: 0, word: 1, clip: 2, playhead: 3, edge: 4 }

export function snapPoints(input: {
  words: readonly CaptionWord[]
  groups: readonly CaptionGroup[]
  clipEdges: readonly number[]
  playhead: number
  end: number
}): SnapPoint[] {
  const points: SnapPoint[] = [
    { time: 0, kind: 'edge' },
    { time: input.playhead, kind: 'playhead' },
    ...input.clipEdges.map((time) => ({ time, kind: 'clip' as const })),
    ...input.words.flatMap((w) => [
      { time: w.start, kind: 'word' as const },
      { time: w.end, kind: 'word' as const },
    ]),
    ...input.groups.flatMap((g) => [
      { time: g.start, kind: 'caption' as const },
      { time: g.end, kind: 'caption' as const },
    ]),
  ]
  if (input.end > 0) points.push({ time: input.end, kind: 'edge' })
  return points
    .filter((p) => p.time >= START_ZONE || p.kind === 'edge' || p.kind === 'playhead' || p.kind === 'clip')
    .sort((a, b) => a.time - b.time || PRIORITY[a.kind] - PRIORITY[b.kind])
}

/** The point nearest to `time` within `threshold` seconds, by binary search. */
export function nearestPoint(points: readonly SnapPoint[], time: number, threshold: number): SnapPoint | null {
  let low = 0
  let high = points.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (points[mid].time < time) low = mid + 1
    else high = mid
  }
  let best: SnapPoint | null = null
  for (const index of [low - 1, low, low + 1]) {
    const point = points[index]
    if (!point) continue
    const distance = Math.abs(point.time - time)
    if (distance <= threshold && (!best || distance < Math.abs(best.time - time) - 1e-9)) best = point
  }
  // Prefer the higher-priority point among those at exactly the same time.
  if (best) {
    const tied = points.filter((p) => Math.abs(p.time - best!.time) < 1e-9)
    best = tied.reduce((a, b) => (PRIORITY[b.kind] < PRIORITY[a.kind] ? b : a), best)
  }
  return best
}

/**
 * Snaps a moving clip: whichever of its edges is nearest a point decides.
 * Returns the shift to apply to the proposed start and the point it snapped to.
 */
export function snapEdges(
  points: readonly SnapPoint[],
  edges: readonly number[],
  threshold: number,
): { shift: number; point: SnapPoint | null } {
  let best: { shift: number; point: SnapPoint | null } = { shift: 0, point: null }
  for (const edge of edges) {
    const point = nearestPoint(points, edge, threshold)
    if (point && (!best.point || Math.abs(point.time - edge) < Math.abs(best.shift))) {
      best = { shift: point.time - edge, point }
    }
  }
  return best
}
