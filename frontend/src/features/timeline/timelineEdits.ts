// Timeline actions with undo. Each edit replaces the project's clips with the result of a
// pure function from clipOps.ts, or changes the ranking or the scenes, and remembers all three
// as they were before it: Undo and Redo cover clip, ranking and scene edits alike, in the order
// they were made. (Scene previews aren't in it: undo never removes one; see scenePreviews.ts.)
import { produce } from 'immer'
import { create } from 'zustand'
import type { LibraryItem } from '../../lib/api'
import { newId } from '../../lib/ids'
import { useProjectStore, updateProject } from '../../state/project/store'
import type { Ranking, Scene, TimelineClip } from '../../state/project/types'
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

/** What one undo step brings back. The ranking and the scenes are in it as a whole, so every
 * ranking change has to go through editRanking, and every scene change through editScenes (or
 * editTimeline): Undo would silently revert one that didn't. */
export interface TimelineSnapshot {
  clips: TimelineClip[]
  ranking: Ranking
  scenes: Scene[]
}

interface HistoryState {
  past: TimelineSnapshot[]
  future: TimelineSnapshot[]
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

function snapshot(): TimelineSnapshot {
  const { clips, ranking, scenes } = useProjectStore.getState().project
  return { clips, ranking, scenes }
}

function restore({ clips, ranking, scenes }: TimelineSnapshot) {
  updateProject((p) => {
    p.clips = clips
    p.ranking = ranking
    p.scenes = scenes
  })
  const { selectedClipId, selectedSceneId } = useUi.getState()
  if (selectedClipId && !clips.some((c) => c.id === selectedClipId)) setUi({ selectedClipId: null })
  if (selectedSceneId && !scenes.some((s) => s.id === selectedSceneId)) setUi({ selectedSceneId: null })
}

/**
 * Records `before` as an undo step for the edit about to be applied. Edits sharing `mergeKey`
 * in quick succession (e.g. dragging the crop slider, typing a label) undo together.
 */
function remember(before: TimelineSnapshot, mergeKey?: string) {
  const now = Date.now()
  const merge = mergeKey !== undefined && lastMerge?.key === mergeKey && now - lastMerge.at < MERGE_MS
  lastMerge = mergeKey === undefined ? null : { key: mergeKey, at: now }
  if (!merge) {
    useTimelineHistory.setState((s) => ({ past: [...s.past.slice(-HISTORY_LIMIT + 1), before], future: [] }))
  }
}

/** Applies a change to the clips (return null for "nothing to do"). See remember for `mergeKey`. */
export function editClips(change: (clips: readonly TimelineClip[]) => TimelineClip[] | null, mergeKey?: string): boolean {
  const before = snapshot()
  const after = change(before.clips)
  if (!after || JSON.stringify(after) === JSON.stringify(before.clips)) return false
  remember(before, mergeKey)
  restore({ ...before, clips: after })
  return true
}

/** Changes the ranking with an Immer recipe. See remember for `mergeKey`. */
export function editRanking(recipe: (draft: Ranking) => void, mergeKey?: string): boolean {
  const before = snapshot()
  const after = produce(before.ranking, recipe)
  if (JSON.stringify(after) === JSON.stringify(before.ranking)) return false
  remember(before, mergeKey)
  restore({ ...before, ranking: after })
  return true
}

/**
 * Changes several parts in one undo step, e.g. a stock clip placed for a scene (the clips and
 * the scene). `change` returns the parts it changes, or null for "nothing to do".
 */
export function editTimeline(change: (before: TimelineSnapshot) => Partial<TimelineSnapshot> | null, mergeKey?: string): boolean {
  const before = snapshot()
  const changes = change(before)
  if (!changes) return false
  const after = { ...before, ...changes }
  if (JSON.stringify(after) === JSON.stringify(before)) return false
  remember(before, mergeKey)
  restore(after)
  return true
}

/** Applies a change to the scenes (return null for "nothing to do"). See remember for `mergeKey`. */
export function editScenes(change: (scenes: readonly Scene[]) => Scene[] | null, mergeKey?: string): boolean {
  return editTimeline((before) => {
    const scenes = change(before.scenes)
    return scenes && { scenes }
  }, mergeKey)
}

export function undo() {
  const { past, future } = useTimelineHistory.getState()
  const previous = past[past.length - 1]
  if (!previous) return
  lastMerge = null
  useTimelineHistory.setState({ past: past.slice(0, -1), future: [snapshot(), ...future] })
  restore(previous)
}

export function redo() {
  const { past, future } = useTimelineHistory.getState()
  const next = future[0]
  if (!next) return
  lastMerge = null
  useTimelineHistory.setState({ past: [...past, snapshot()], future: future.slice(1) })
  restore(next)
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
