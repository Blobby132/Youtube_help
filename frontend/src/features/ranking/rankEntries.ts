// Ranking entries and the timeline: which rank each entry has, which clip it shows over, and
// what's wrong when it can't be shown. Shared by the Ranking tab, the Ranks lane and the preview.
import type { RankEntry, Ranking, TimelineClip } from '../../state/project/types'
import { clipAt, clipEnd } from '../timeline/clipOps'

/** The number an entry shows: counting down, the first entry is #N; counting up, #1. */
export function rankNumber(index: number, count: number, direction: Ranking['direction']): number {
  return direction === 'down' ? count - index : index + 1
}

/** Label of the order control, e.g. "Count down 4→1" (5 until there are two entries). */
export function orderLabel(direction: Ranking['direction'], count: number): string {
  const n = count >= 2 ? count : 5
  return direction === 'down' ? `Count down ${n}→1` : `Count up 1→${n}`
}

export type RankProblem =
  /** No clip picked yet. */
  | 'no-clip'
  /** The clip was deleted from the timeline (or replaced by Auto-fill). */
  | 'clip-removed'
  /** Its clip plays before the clip of the entry above, so the count would go out of order. */
  | 'out-of-order'

export interface RankSpan {
  entry: RankEntry
  index: number
  rank: number
  /** The linked clip, if it's on the timeline. */
  clip: TimelineClip | null
  problem: RankProblem | null
  /** For 'out-of-order': the rank of the entry whose clip plays after this one's. */
  before: number | null
}

/** Every entry with its rank, its clip and anything that stops it showing as expected. */
export function rankSpans(ranking: Ranking, clips: readonly TimelineClip[]): RankSpan[] {
  const byId = new Map(clips.map((clip) => [clip.id, clip]))
  const count = ranking.entries.length
  let previous: { start: number; rank: number } | null = null
  return ranking.entries.map((entry, index) => {
    const rank = rankNumber(index, count, ranking.direction)
    const clip = entry.clipId ? (byId.get(entry.clipId) ?? null) : null
    let problem: RankProblem | null = entry.clipId === null ? 'no-clip' : clip ? null : 'clip-removed'
    let before: number | null = null
    if (clip) {
      if (previous && clip.start < previous.start) {
        problem = 'out-of-order'
        before = previous.rank
      }
      previous = { start: clip.start, rank }
    }
    return { entry, index, rank, clip, problem, before }
  })
}

/** The entry on screen at `time`: the one linked to the clip playing then. */
export function rankAt(ranking: Ranking, clips: readonly TimelineClip[], time: number): { entry: RankEntry; rank: number } | null {
  if (!ranking.enabled) return null
  const clip = clipAt(clips, time)
  if (!clip) return null
  const index = ranking.entries.findIndex((entry) => entry.clipId === clip.id)
  if (index < 0) return null
  return { entry: ranking.entries[index], rank: rankNumber(index, ranking.entries.length, ranking.direction) }
}

/**
 * The clip a new entry links to: the selected clip, else the one under the playhead, else the
 * first clip after the last linked one. Never a clip another entry already uses.
 */
export function clipForNewEntry(
  clips: readonly TimelineClip[],
  entries: readonly RankEntry[],
  selectedId: string | null,
  playhead: number,
): string | null {
  const used = new Set(entries.map((entry) => entry.clipId))
  const free = (clip: TimelineClip | undefined) => (clip && !used.has(clip.id) ? clip.id : null)
  const linkedEnd = Math.max(0, ...clips.filter((clip) => used.has(clip.id)).map(clipEnd))
  return (
    free(clips.find((clip) => clip.id === selectedId)) ??
    free(clipAt(clips, playhead)) ??
    free([...clips].sort((a, b) => a.start - b.start).find((clip) => !used.has(clip.id) && clip.start >= linkedEnd - 1e-3)) ??
    null
  )
}

/** Moves the entry at `from` to `to`, shifting the ones in between. */
export function moveEntry<T>(entries: readonly T[], from: number, to: number): T[] {
  const result = [...entries]
  if (from === to || from < 0 || from >= result.length) return result
  const [moved] = result.splice(from, 1)
  result.splice(Math.max(0, Math.min(to, result.length)), 0, moved)
  return result
}
