// Changes to the ranking entries. They're saved with the project like every other setting.
import { newId } from '../../lib/ids'
import { updateProject, useProjectStore } from '../../state/project/store'
import type { RankEntry, Ranking, RankStyle } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { clipForNewEntry, moveEntry } from './rankEntries'

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

/** Adds an entry at the end, linked to the clip clipForNewEntry picks. Returns its id. */
export function addEntry(): string {
  const { clips, ranking } = useProjectStore.getState().project
  const { selectedClipId, playhead } = useUi.getState()
  const entry: RankEntry = { id: newId('r'), label: '', clipId: clipForNewEntry(clips, ranking.entries, selectedClipId, playhead) }
  updateProject((p) => {
    p.ranking.entries.push(entry)
  })
  return entry.id
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
