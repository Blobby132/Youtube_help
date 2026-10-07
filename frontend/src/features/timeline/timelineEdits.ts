// Timeline actions with undo. Each edit replaces the project's clips with the result of a
// pure function from clipOps.ts and remembers the clips before it.
import { create } from 'zustand'
import type { LibraryItem } from '../../lib/api'
import { newId } from '../../lib/ids'
import { useProjectStore, updateProject } from '../../state/project/store'
import type { TimelineClip } from '../../state/project/types'
import { setUi, useUi } from '../../state/ui'
import { useLibrary } from '../library/libraryStore'
import {
  appendClip,
  clipAt,
  fitToVoiceover,
  insertClip,
  removeClip,
  setSpeed,
  splitClip,
  type SourceLength,
} from './clipOps'

const HISTORY_LIMIT = 100
/** Slider drags arrive as many small edits; within this window they undo as one. */
const MERGE_MS = 1200

interface HistoryState {
  past: TimelineClip[][]
  future: TimelineClip[][]
  /** Shown in the toolbar for a few seconds after an edit that needs explaining. */
  notice: string | null
}

export const useTimelineHistory = create<HistoryState>()(() => ({ past: [], future: [], notice: null }))

let lastMerge: { key: string; at: number } | null = null
let noticeTimer: ReturnType<typeof setTimeout> | undefined

// Another project means another history.
let historyProjectId = useProjectStore.getState().project.id
useProjectStore.subscribe((state) => {
  if (state.project.id === historyProjectId) return
  historyProjectId = state.project.id
  lastMerge = null
  useTimelineHistory.setState({ past: [], future: [], notice: null })
})

const currentClips = () => useProjectStore.getState().project.clips

function setClips(clips: TimelineClip[]) {
  updateProject((p) => {
    p.clips = clips
  })
  const selected = useUi.getState().selectedClipId
  if (selected && !clips.some((c) => c.id === selected)) setUi({ selectedClipId: null })
}

/**
 * Applies a change to the clips (return null for "nothing to do"). Edits sharing `mergeKey`
 * in quick succession (e.g. dragging the crop slider) undo together.
 */
export function editClips(change: (clips: readonly TimelineClip[]) => TimelineClip[] | null, mergeKey?: string): boolean {
  const before = currentClips()
  const after = change(before)
  if (!after || JSON.stringify(after) === JSON.stringify(before)) return false
  const now = Date.now()
  const merge = mergeKey !== undefined && lastMerge?.key === mergeKey && now - lastMerge.at < MERGE_MS
  lastMerge = mergeKey === undefined ? null : { key: mergeKey, at: now }
  if (!merge) {
    useTimelineHistory.setState((s) => ({ past: [...s.past.slice(-HISTORY_LIMIT + 1), before], future: [] }))
  }
  setClips(after)
  return true
}

export function undo() {
  const { past, future } = useTimelineHistory.getState()
  const previous = past[past.length - 1]
  if (!previous) return
  lastMerge = null
  useTimelineHistory.setState({ past: past.slice(0, -1), future: [currentClips(), ...future] })
  setClips(previous)
}

export function redo() {
  const { past, future } = useTimelineHistory.getState()
  const next = future[0]
  if (!next) return
  lastMerge = null
  useTimelineHistory.setState({ past: [...past, currentClips()], future: future.slice(1) })
  setClips(next)
}

export function showNotice(notice: string | null) {
  clearTimeout(noticeTimer)
  useTimelineHistory.setState({ notice })
  if (notice) noticeTimer = setTimeout(() => useTimelineHistory.setState({ notice: null }), 6000)
}

/** Source length of each clip's media: null for images, undefined if it's not in the library. */
export function sourceLengths(items: readonly LibraryItem[] = useLibrary.getState().items): SourceLength {
  const byId = new Map(items.map((item) => [item.id, item]))
  return (mediaId) => {
    const item = byId.get(mediaId)
    if (!item) return undefined
    return item.kind === 'image' ? null : item.duration
  }
}

/** The video's length for placing clips: the voiceover's end (0 without one). */
const videoEnd = () => useProjectStore.getState().project.voiceover?.duration ?? 0

/** Adds a library item to the timeline, at `at` (where it was dropped) or in the first gap. */
export function addToTimeline(item: LibraryItem, at?: number): string {
  const id = newId('c')
  const media = { id: item.id, duration: item.kind === 'image' ? null : item.duration }
  editClips((clips) =>
    at === undefined ? appendClip(clips, media, videoEnd(), id) : insertClip(clips, media, at, videoEnd(), id),
  )
  setUi({ selectedClipId: id })
  return id
}

export function updateClip(id: string, patch: Partial<Omit<TimelineClip, 'id' | 'mediaId'>>, mergeKey?: string) {
  editClips((clips) => clips.map((c) => (c.id === id ? { ...c, ...patch } : c)), mergeKey && `${mergeKey}:${id}`)
}

export function changeSpeed(id: string, speed: number) {
  editClips((clips) => setSpeed(clips, id, speed, sourceLengths()))
}

/** The clip Split and Delete act on: the selected one, else the one under the playhead. */
export function targetClip(): TimelineClip | undefined {
  const clips = currentClips()
  const selected = clips.find((c) => c.id === useUi.getState().selectedClipId)
  return selected ?? clipAt(clips, useUi.getState().playhead)
}

export function splitAtPlayhead(): boolean {
  const { playhead } = useUi.getState()
  const clips = currentClips()
  const selected = clips.find((c) => c.id === useUi.getState().selectedClipId)
  const clip = selected && playhead > selected.start && playhead < selected.start + selected.duration ? selected : clipAt(clips, playhead)
  if (!clip) {
    showNotice('Move the playhead over a clip to split it there.')
    return false
  }
  const done = editClips((current) => splitClip(current, clip.id, playhead, newId('c')))
  if (!done) showNotice('Too close to the clip’s edge to split there.')
  return done
}

export function deleteSelected() {
  const id = useUi.getState().selectedClipId
  if (id) editClips((clips) => removeClip(clips, id))
}

/** "Fit to voiceover": no gaps, nothing past the end. Explains anything it had to change. */
export function fitClips() {
  const end = videoEnd()
  if (end <= 0) return showNotice('Make a voiceover first: the video is as long as the voiceover.')
  if (!currentClips().length) return showNotice('Add some clips first.')
  const { clips, removed, slowed, gapsLeft } = fitToVoiceover(currentClips(), end, sourceLengths())
  const changed = editClips(() => clips)
  const notes = [
    !changed && 'The clips already fit the voiceover.',
    removed && `Removed ${removed} ${removed === 1 ? 'clip' : 'clips'} that started after the voiceover ends.`,
    slowed && `Slowed ${slowed} ${slowed === 1 ? 'clip' : 'clips'} down to fill ${slowed === 1 ? 'its' : 'their'} stretch.`,
    gapsLeft && `${gapsLeft} ${gapsLeft === 1 ? 'gap is' : 'gaps are'} left: even at quarter speed the clip is too short.`,
  ].filter(Boolean)
  showNotice(notes.length ? notes.join(' ') : null)
}
