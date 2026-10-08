// Changes to the ranking. They're saved with the project like every other setting, and each one
// goes through editRanking, so Undo and Redo cover it like the clip edits.
import { newId } from '../../lib/ids'
import { formatTimecode, parseTimecode } from '../../lib/time'
import { useProjectStore } from '../../state/project/store'
import type { RankEntry, Ranking, RankStyle, TimeRange } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { editRanking } from '../timeline/timelineEdits'
import { moveEntry, rangeForNewEntry, setEntryEdge } from './rankEntries'

export function setRanking(patch: Partial<Omit<Ranking, 'entries' | 'style'>>) {
  editRanking((r) => {
    Object.assign(r, patch)
  })
}

/** `mergeKey` makes a slider or colour drag undo as one step. */
export function setRankStyle(patch: Partial<RankStyle>, mergeKey?: string) {
  editRanking((r) => {
    Object.assign(r.style, patch)
  }, mergeKey && `rank-style:${mergeKey}`)
}

/** Where rangeForNewEntry puts an entry now: the selected clip, or the sentence under the playhead. */
function defaultRange(excludeId?: string): TimeRange | null {
  const { clips, ranking, captions } = useProjectStore.getState().project
  const { selectedClipId, playhead } = useUi.getState()
  return rangeForNewEntry({ entries: ranking.entries, clips, words: captions.words, selectedClipId, playhead, excludeId })
}

/** Adds an entry at the end, timed by rangeForNewEntry. Returns its id. */
export function addEntry(): string {
  const entry: RankEntry = { id: newId('r'), label: '', time: defaultRange() }
  editRanking((r) => {
    r.entries.push(entry)
  })
  return entry.id
}

/** Gives an entry the time a new entry would get (for one that has none yet, or to move it). */
export function retimeEntry(id: string) {
  const time = defaultRange(id)
  if (time) updateEntry(id, { time })
}

/** `mergeKey` makes typing (e.g. a label) undo as one step. */
export function updateEntry(id: string, patch: Partial<Omit<RankEntry, 'id'>>, mergeKey?: string) {
  editRanking((r) => {
    const entry = r.entries.find((e) => e.id === id)
    if (entry) Object.assign(entry, patch)
  }, mergeKey && `${mergeKey}:${id}`)
}

/** Puts in the entries from a finished drag on the Ranks lane. */
export function setEntries(entries: RankEntry[]) {
  editRanking((r) => {
    r.entries = entries
  })
}

/**
 * Sets an entry's start or end to a typed time. Returns why it can't (not a time, before the
 * start, overlapping another entry, …), or null once it's done.
 */
export function setEntryTime(id: string, edge: 'start' | 'end', text: string): string | null {
  const seconds = parseTimecode(text)
  if (seconds === null) {
    const problem = text.trim() ? `“${text.trim()}” isn’t a time.` : edge === 'start' ? 'Type a start time.' : 'Type an end time.'
    return `${problem} Type minutes and seconds like ${formatTimecode(3.04)}, or seconds like 3.04.`
  }
  const result = setEntryEdge(useProjectStore.getState().project.ranking, id, edge, seconds)
  if ('error' in result) return result.error
  setEntries(result.entries)
  return null
}

export function removeEntry(id: string) {
  editRanking((r) => {
    r.entries = r.entries.filter((e) => e.id !== id)
  })
}

export function reorderEntry(from: number, to: number) {
  editRanking((r) => {
    r.entries = moveEntry(r.entries, from, to)
  })
}
