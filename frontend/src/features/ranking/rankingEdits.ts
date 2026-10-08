// Changes to the ranking entries. They're saved with the project like every other setting.
import { newId } from '../../lib/ids'
import { updateProject, useProjectStore } from '../../state/project/store'
import type { RankEntry, Ranking, RankStyle, TimeRange } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { moveEntry, rangeForNewEntry } from './rankEntries'

export function setRanking(patch: Partial<Omit<Ranking, 'entries' | 'style'>>) {
  updateProject((p) => {
    Object.assign(p.ranking, patch)
  })
}

export function setRankStyle(patch: Partial<RankStyle>) {
  updateProject((p) => {
    Object.assign(p.ranking.style, patch)
  })
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
  updateProject((p) => {
    p.ranking.entries.push(entry)
  })
  return entry.id
}

/** Gives an entry the time a new entry would get (for one that has none yet, or to move it). */
export function retimeEntry(id: string) {
  const time = defaultRange(id)
  if (time) updateEntry(id, { time })
}

export function updateEntry(id: string, patch: Partial<Omit<RankEntry, 'id'>>) {
  updateProject((p) => {
    const entry = p.ranking.entries.find((e) => e.id === id)
    if (entry) Object.assign(entry, patch)
  })
}

export function removeEntry(id: string) {
  updateProject((p) => {
    p.ranking.entries = p.ranking.entries.filter((e) => e.id !== id)
  })
}

export function reorderEntry(from: number, to: number) {
  updateProject((p) => {
    p.ranking.entries = moveEntry(p.ranking.entries, from, to)
  })
}
