// Changes to the scenes. Each one goes through editScenes (or editTimeline), so Undo and Redo
// cover them in order with the clip and ranking edits. Previews are kept apart (scenePreviews.ts):
// undoing a scene edit never removes one.
import { newId } from '../../lib/ids'
import { formatTimecode, parseTimecode } from '../../lib/time'
import { useProjectStore } from '../../state/project/store'
import type { Scene } from '../../state/project/types'
import { setUi, useUi } from '../../state/ui'
import { editScenes, showNotice } from '../timeline/timelineEdits'
import { addScene, deleteScene, MAX_PREVIEWS, mergeWithNext, MIN_PREVIEWS, setSceneEdge, splitPoint, splitScene } from './sceneOps'
import { planScenes, sceneTiming } from './scenePlan'

const currentProject = () => useProjectStore.getState().project

/**
 * "Create scenes from script". Replacing scenes asks first; Undo brings the old ones back, and
 * their previews are kept either way. Returns why it can't, or null.
 */
export function createScenes(): string | null {
  const project = currentProject()
  const scenes = planScenes(sceneTiming(project))
  if (!scenes.length) return 'Write a script first: scenes are made from its sentences.'
  const count = project.scenes.length
  if (count) {
    const question = `Replace the ${count} ${count === 1 ? 'scene' : 'scenes'} with new ones from the script? Undo (Ctrl+Z) brings them back. Previews you made are kept.`
    if (!window.confirm(question)) return null
  }
  editScenes(() => scenes)
  setUi({ selectedSceneId: null })
  showNotice(`Made ${scenes.length} ${scenes.length === 1 ? 'scene' : 'scenes'} from the script.`)
  return null
}

export function selectScene(id: string | null) {
  setUi({ selectedSceneId: id })
}

/** Adds a scene at the playhead (or in the first free time). Returns its id. */
export function addSceneAtPlayhead(): string | null {
  const project = currentProject()
  const id = newId('s')
  const done = editScenes((scenes) => addScene(scenes, useUi.getState().playhead, sceneTiming(project).end, id))
  if (!done) {
    showNotice('There’s no free time for a new scene. Split a scene, or shorten one, to make room.')
    return null
  }
  selectScene(id)
  return id
}

/** Splits a scene at the playhead if it's inside, else near its middle on a word boundary. */
export function splitSceneAt(id: string) {
  const project = currentProject()
  const scene = project.scenes.find((s) => s.id === id)
  if (!scene) return
  const time = splitPoint(scene, useUi.getState().playhead, sceneTiming(project).words.map((w) => w.start))
  const done = time !== null && editScenes((scenes) => splitScene(scenes, id, time, newId('s')))
  if (!done) showNotice('This scene is too short to split.')
}

export function mergeScene(id: string) {
  editScenes((scenes) => mergeWithNext(scenes, id))
}

export function removeScene(id: string) {
  editScenes((scenes) => deleteScene(scenes, id))
}

/** `mergeKey` makes typing (a prompt, a description) undo as one step. */
export function updateScene(id: string, patch: Partial<Omit<Scene, 'id' | 'start' | 'end'>>, mergeKey?: string) {
  editScenes((scenes) => scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)), mergeKey && `scene-${mergeKey}:${id}`)
}

export function setPreviewCount(id: string, count: number) {
  updateScene(id, { previewCount: Math.min(MAX_PREVIEWS, Math.max(MIN_PREVIEWS, Math.round(count))) })
}

/** "Use this" on a preview. */
export function selectPreview(sceneId: string, previewId: string) {
  updateScene(sceneId, { selectedPreviewId: previewId })
}

/** Puts in the scenes from a finished drag on the Scenes lane. */
export function setScenes(scenes: Scene[]) {
  editScenes(() => scenes)
}

/**
 * Sets a scene's start or end to a typed time. Returns why it can't (not a time, before the
 * start, overlapping another scene, …), or null once it's done.
 */
export function setSceneTime(id: string, edge: 'start' | 'end', text: string): string | null {
  const seconds = parseTimecode(text)
  if (seconds === null) {
    const problem = text.trim() ? `“${text.trim()}” isn’t a time.` : edge === 'start' ? 'Type a start time.' : 'Type an end time.'
    return `${problem} Type minutes and seconds like ${formatTimecode(3.04)}, or seconds like 3.04.`
  }
  const result = setSceneEdge(currentProject().scenes, id, edge, seconds)
  if ('error' in result) return result.error
  setScenes(result.scenes)
  return null
}
