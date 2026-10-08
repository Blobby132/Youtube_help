// Ranking entries and the timeline: which rank each entry has, when it's on screen, and what's
// wrong when it can't be shown as expected. Shared by the Ranking tab, the Ranks lane and the
// preview. Each entry has its own time range: clip edits (Auto-fill, Delete, Split, moves)
// never change it, and entries never overlap. (No imports from the timeline: project loading
// uses this file, and clipOps uses the project defaults.)
import type { CaptionWord, RankEntry, Ranking, TimeRange, TimelineClip } from '../../state/project/types'
import { SENTENCE_END } from '../media/autofillPlan'

/** Shortest entry, in seconds. */
export const MIN_RANK = 0.2
/** Length of a new entry when there's no selected clip or sentence to fit. */
export const DEFAULT_RANK_SECONDS = 3

const EPS = 1e-6
const round = (n: number) => Math.round(n * 1e4) / 1e4
const clipEnd = (clip: TimelineClip) => clip.start + clip.duration

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
  /** No time set yet (or a clip link from an old project whose clip was gone). */
  | 'no-time'
  /** It starts before the entry above it, so the count would go out of order. */
  | 'out-of-order'

export interface RankSpan {
  entry: RankEntry
  index: number
  rank: number
  problem: RankProblem | null
  /** For 'out-of-order': the rank of the entry that plays after this one. */
  before: number | null
}

/** Every entry with its rank and anything that stops it showing as expected. */
export function rankSpans(ranking: Ranking): RankSpan[] {
  const count = ranking.entries.length
  let previous: { start: number; rank: number } | null = null
  return ranking.entries.map((entry, index) => {
    const rank = rankNumber(index, count, ranking.direction)
    let problem: RankProblem | null = entry.time ? null : 'no-time'
    let before: number | null = null
    if (entry.time) {
      if (previous && entry.time.start < previous.start) {
        problem = 'out-of-order'
        before = previous.rank
      }
      previous = { start: entry.time.start, rank }
    }
    return { entry, index, rank, problem, before }
  })
}

/** The entry on screen at `time`. */
export function rankAt(ranking: Ranking, time: number): { entry: RankEntry; rank: number } | null {
  if (!ranking.enabled) return null
  const index = ranking.entries.findIndex((e) => e.time && time >= e.time.start - EPS && time < e.time.end - EPS)
  if (index < 0) return null
  return { entry: ranking.entries[index], rank: rankNumber(index, ranking.entries.length, ranking.direction) }
}

/** Sentences of the captions: runs of words up to one ending in . ! ? or … (quotes allowed after). */
export function sentences(words: readonly CaptionWord[]): TimeRange[] {
  const result: TimeRange[] = []
  let start: number | null = null
  words.forEach((word, i) => {
    start ??= word.start
    if (SENTENCE_END.test(word.text) || i === words.length - 1) {
      result.push({ start, end: word.end })
      start = null
    }
  })
  return result
}

export function sentenceAt(words: readonly CaptionWord[], time: number): TimeRange | null {
  return sentences(words).find((s) => time >= s.start - EPS && time < s.end - EPS) ?? null
}

/** Times taken by the other entries, sorted. */
function taken(entries: readonly RankEntry[], excludeId?: string): TimeRange[] {
  return entries
    .filter((e) => e.id !== excludeId && e.time)
    .map((e) => e.time!)
    .sort((a, b) => a.start - b.start)
}

/** The longest part of `wanted` no other entry uses, or null if none is at least MIN_RANK long. */
export function fitRange(entries: readonly RankEntry[], wanted: TimeRange, excludeId?: string): TimeRange | null {
  const pieces: TimeRange[] = []
  let cursor = Math.max(0, wanted.start)
  for (const other of taken(entries, excludeId)) {
    if (other.end <= cursor + EPS) continue
    if (other.start >= wanted.end - EPS) break
    pieces.push({ start: cursor, end: Math.min(other.start, wanted.end) })
    cursor = Math.max(cursor, other.end)
  }
  pieces.push({ start: cursor, end: wanted.end })
  // The first of the longest pieces.
  const best = pieces.reduce<TimeRange | null>((b, p) => (!b || p.end - p.start > b.end - b.start + EPS ? p : b), null)
  if (!best || best.end - best.start < MIN_RANK - EPS) return null
  return { start: round(best.start), end: round(best.end) }
}

/**
 * When a new entry plays (or an entry being given a time): the selected clip's span, else the
 * sentence under the playhead, else DEFAULT_RANK_SECONDS from the playhead, else right after
 * the last entry. Whichever comes first and has room is trimmed to the time no other entry uses.
 */
export function rangeForNewEntry(input: {
  entries: readonly RankEntry[]
  clips: readonly TimelineClip[]
  words: readonly CaptionWord[]
  selectedClipId: string | null
  playhead: number
  /** An entry being re-timed: its own time doesn't count as taken. */
  excludeId?: string
}): TimeRange | null {
  const { entries, playhead, excludeId } = input
  const selected = input.clips.find((c) => c.id === input.selectedClipId)
  const lastEnd = Math.max(0, ...taken(entries, excludeId).map((t) => t.end))
  const candidates = [
    selected && { start: selected.start, end: clipEnd(selected) },
    sentenceAt(input.words, playhead),
    { start: playhead, end: playhead + DEFAULT_RANK_SECONDS },
    { start: lastEnd, end: lastEnd + DEFAULT_RANK_SECONDS },
  ]
  for (const wanted of candidates) {
    const range = wanted && fitRange(entries, wanted, excludeId)
    if (range) return range
  }
  return null
}

/**
 * Drags one edge of an entry to `proposed`. It stops at the neighbouring entries, at 0, and
 * MIN_RANK from its other edge.
 */
export function resizeEntry(entries: readonly RankEntry[], id: string, edge: 'start' | 'end', proposed: number): RankEntry[] {
  return entries.map((entry) => {
    if (entry.id !== id || !entry.time) return entry
    const { start, end } = entry.time
    const others = taken(entries, id)
    if (edge === 'start') {
      const previousEnd = others.filter((o) => o.end <= start + EPS).reduce((e, o) => Math.max(e, o.end), 0)
      return { ...entry, time: { start: round(Math.min(Math.max(proposed, previousEnd), end - MIN_RANK)), end } }
    }
    const nextStart = others.filter((o) => o.start >= end - EPS).reduce((s, o) => Math.min(s, o.start), Infinity)
    return { ...entry, time: { start, end: round(Math.max(Math.min(proposed, nextStart), start + MIN_RANK)) } }
  })
}

/**
 * Times for entries saved before version 2, which showed over a linked clip: the clip's span,
 * or null if it's gone. An entry that would overlap an earlier one gets null too.
 */
export function timesFromClipLinks(clipIds: readonly (string | null)[], clips: readonly TimelineClip[]): (TimeRange | null)[] {
  const byId = new Map(clips.map((clip) => [clip.id, clip]))
  const used: TimeRange[] = []
  return clipIds.map((clipId) => {
    const clip = clipId ? byId.get(clipId) : undefined
    if (!clip) return null
    const time = { start: round(clip.start), end: round(clipEnd(clip)) }
    if (used.some((u) => time.start < u.end - EPS && time.end > u.start + EPS)) return null
    used.push(time)
    return time
  })
}

/** Moves the entry at `from` to `to`, shifting the ones in between. */
export function moveEntry<T>(entries: readonly T[], from: number, to: number): T[] {
  const result = [...entries]
  if (from === to || from < 0 || from >= result.length) return result
  const [moved] = result.splice(from, 1)
  result.splice(Math.max(0, Math.min(to, result.length)), 0, moved)
  return result
}
