// AI scene finals. A final is made from the scene's chosen preview by the backend (POST
// /api/comfy/finals): ComfyUI loads that preview's own saved first pass and runs only the
// workflow's upscale and refine passes, so the final is the same shot at the Final size, not a
// new video. Like previews, the project keeps its own record of each final (sceneFinals) and
// follows its job (scenePreviews.ts syncs both). Not on the undo history.
import type { LibraryItem } from '../../lib/api'
import { newId } from '../../lib/ids'
import { updateProject, useProjectStore } from '../../state/project/store'
import type { Scene, SceneFinal, ScenePreview } from '../../state/project/types'
import { cancelShot, generateFinalJob } from '../generate/generateStore'
import { useLibrary } from '../library/libraryStore'
import { dismissJob, forgetMissing, isPreviewActive } from './scenePreviews'

/** On a preview made before finals could match their previews (it has no saved first pass). */
export const OLD_PREVIEW =
  'This preview was made before finals could match their previews, so a final made from it would be a different video. Generate new previews and use one of those.'

/** Refine seeds stay below 2**50, like the backend's seeds. */
const MAX_SEED = 2 ** 50
const newSeed = () => Math.floor(Math.random() * (MAX_SEED - 1)) + 1

const currentProject = () => useProjectStore.getState().project

/** A preview made before finals could match: its clip has no saved first pass. */
export const isOldPreview = (item: LibraryItem | undefined) => !!item && item.generation?.type === 'preview' && !item.latents

export type FinalSource = { preview: ScenePreview; item: LibraryItem } | { problem: string }

/**
 * What a scene's final would be made from: its chosen preview, finished, with its first pass
 * saved. Otherwise why there's none. `items` is the library (null while it's loading).
 */
export function finalSource(scene: Scene, previews: readonly ScenePreview[], items: readonly LibraryItem[] | null): FinalSource {
  const preview = previews.find((p) => p.id === scene.selectedPreviewId && p.sceneId === scene.id)
  if (!preview) return { problem: 'Choose a preview first (Use this): the final is made from it.' }
  if (preview.status !== 'done' || !preview.itemId) return { problem: 'The chosen preview isn’t finished.' }
  if (!items) return { problem: 'Loading the library…' }
  const item = items.find((i) => i.id === preview.itemId)
  if (!item) return { problem: 'The chosen preview’s clip is no longer in the library. Choose another preview.' }
  if (!item.latents) return { problem: OLD_PREVIEW }
  return { preview, item }
}

function library(): readonly LibraryItem[] | null {
  const { items, status } = useLibrary.getState()
  return status === 'ready' ? items : null
}

/**
 * "Generate final" (and "Regenerate final", which uses a new refine seed): queues the scene's
 * final from its chosen preview. Returns the new final's id (null if another project was opened
 * meanwhile). Throws with the reason it can't (no preview chosen, an old preview, ComfyUI closed…).
 * Only this scene changes.
 */
export async function generateFinal(sceneId: string, regenerate = false): Promise<string | null> {
  const project = currentProject()
  const scene = project.scenes.find((s) => s.id === sceneId)
  if (!scene) throw new Error('That scene no longer exists.')
  const source = finalSource(scene, project.scenePreviews, library())
  if ('problem' in source) throw new Error(source.problem)
  const job = await generateFinalJob({
    previewItemId: source.item.id,
    scene: { projectId: project.id, sceneId },
    ...(regenerate ? { seed: newSeed() } : {}),
  })
  if (currentProject().id !== project.id) return null
  const final: SceneFinal = {
    id: newId('f'),
    sceneId,
    previewId: source.preview.id,
    previewItemId: source.item.id,
    jobId: job.id,
    refineSeed: job.refineSeed ?? null,
    status: job.status,
    error: job.error,
    itemId: null,
    createdAt: job.createdAt,
  }
  updateProject((p) => {
    p.sceneFinals.push(final)
  })
  return final.id
}

/**
 * Retry on a failed (or cancelled) final: the same preview and refine seed again, as a new job.
 * Only that final changes.
 */
export async function retryFinal(finalId: string): Promise<void> {
  const project = currentProject()
  const final = project.sceneFinals.find((f) => f.id === finalId)
  if (!final || isPreviewActive(final) || final.status === 'done') return
  const job = await generateFinalJob({
    previewItemId: final.previewItemId,
    scene: { projectId: project.id, sceneId: final.sceneId },
    ...(final.refineSeed !== null ? { seed: final.refineSeed } : {}),
  })
  if (currentProject().id !== project.id) return
  updateProject((p) => {
    const target = p.sceneFinals.find((f) => f.id === finalId)
    if (target) Object.assign(target, { jobId: job.id, status: job.status, error: job.error, itemId: null })
  })
  forgetMissing(final.jobId)
  dismissJob(final.jobId)
}

export function cancelFinal(finalId: string) {
  const final = currentProject().sceneFinals.find((f) => f.id === finalId)
  if (final && isPreviewActive(final)) void cancelShot(final.jobId)
}
