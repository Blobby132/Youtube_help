// Putting AI scenes' finals on the timeline: each over exactly its scene's time (placeClip, as
// stock footage is), in place of what's there. Clips already in that time are only replaced after
// asking. A final already on the timeline isn't added again. Each Add is one undo step, however
// many finals it places.
import type { LibraryItem } from '../../lib/api'
import { newId } from '../../lib/ids'
import { formatTimecode } from '../../lib/time'
import { useProjectStore } from '../../state/project/store'
import type { Project, Scene } from '../../state/project/types'
import { useLibrary } from '../library/libraryStore'
import { clipEnd, placeClip } from '../timeline/clipOps'
import { editTimeline, showNotice } from '../timeline/timelineEdits'
import { finalOf } from './sceneOps'

const EPS = 1e-6

type Timeline = Pick<Project, 'scenes' | 'sceneFinals' | 'clips'>

/** A finished final that can go on the timeline over its scene. */
export interface FinalPlacement {
  sceneId: string
  /** The scene's number (its position in the list). */
  number: number
  start: number
  end: number
  item: LibraryItem
  /** Clips are already in the scene's time (they'd be replaced). */
  covered: boolean
}

/** The scene's final clip, once it's finished and in the library. */
export function finalItem(project: Pick<Project, 'sceneFinals'>, items: readonly LibraryItem[], sceneId: string): LibraryItem | undefined {
  const final = finalOf(project.sceneFinals, sceneId)
  if (final?.status !== 'done' || !final.itemId) return undefined
  return items.find((item) => item.id === final.itemId)
}

/** Whether a clip of this library item is on the timeline. */
export const isOnTimeline = (project: Pick<Project, 'clips'>, itemId: string) => project.clips.some((clip) => clip.mediaId === itemId)

/** Clips with some of their time inside the scene's. */
export const clipsIn = (project: Pick<Project, 'clips'>, scene: Pick<Scene, 'start' | 'end'>) =>
  project.clips.filter((clip) => clip.start < scene.end - EPS && clipEnd(clip) > scene.start + EPS)

/**
 * The finals "Add to timeline" would place: AI scenes (all, or `sceneIds`) whose final is
 * finished, in the library and not on the timeline yet, in scene order.
 */
export function finalsToPlace(project: Timeline, items: readonly LibraryItem[], sceneIds?: readonly string[]): FinalPlacement[] {
  return project.scenes.flatMap((scene, index) => {
    if (scene.source !== 'ai' || (sceneIds && !sceneIds.includes(scene.id))) return []
    const item = finalItem(project, items, scene.id)
    if (!item || isOnTimeline(project, item.id)) return []
    return [{ sceneId: scene.id, number: index + 1, start: scene.start, end: scene.end, item, covered: clipsIn(project, scene).length > 0 }]
  })
}

/** Puts the finals over their scenes, in place of what's there, as one undo step. */
export function placeFinals(placements: readonly FinalPlacement[]): boolean {
  if (!placements.length) return false
  return editTimeline(({ clips, scenes }) => {
    let next = clips
    for (const placement of placements) {
      const scene = scenes.find((s) => s.id === placement.sceneId)
      if (!scene) continue
      const media = { id: placement.item.id, duration: placement.item.duration }
      next = placeClip(next, media, scene.start, scene.end, newId('c'), newId('c'))
    }
    return { clips: next }
  })
}

const span = (placement: FinalPlacement) => `${formatTimecode(placement.start)}–${formatTimecode(placement.end)}`

/** "Scene 2 (0:03.00–0:05.33)", for questions. */
export const describePlacement = (placement: FinalPlacement) => `Scene ${placement.number} (${span(placement)})`

/**
 * A scene's "Add to timeline". Asks before replacing clips already in the scene's time. Returns
 * whether it was added.
 */
export function addFinalToTimeline(sceneId: string): boolean {
  const [placement] = finalsToPlace(useProjectStore.getState().project, useLibrary.getState().items, [sceneId])
  if (!placement) return false
  if (placement.covered) {
    const question = `Scene ${placement.number} already has clips between ${formatTimecode(placement.start)} and ${formatTimecode(placement.end)}. Replace them with its final? Undo (Ctrl+Z) brings them back.`
    if (!window.confirm(question)) return false
  }
  const added = placeFinals([placement])
  if (added) showNotice(`Scene ${placement.number}’s final is on the timeline from ${formatTimecode(placement.start)} to ${formatTimecode(placement.end)}.`)
  return added
}

/** "Add all to timeline", once the question (if any) is answered: `replace` false leaves the
 * scenes that already have clips as they are. Returns how many finals it placed. */
export function addAllFinalsToTimeline(replace: boolean): number {
  const all = finalsToPlace(useProjectStore.getState().project, useLibrary.getState().items)
  const placements = replace ? all : all.filter((p) => !p.covered)
  if (!placeFinals(placements)) return 0
  const skipped = all.length - placements.length
  showNotice(
    `Added ${placements.length} ${placements.length === 1 ? 'final' : 'finals'} to the timeline.` +
      (skipped ? ` Left ${skipped} ${skipped === 1 ? 'scene' : 'scenes'} that already had clips as ${skipped === 1 ? 'it was' : 'they were'}.` : '') +
      ' Undo (Ctrl+Z) takes them back out.',
  )
  return placements.length
}
