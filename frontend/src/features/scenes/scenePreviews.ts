// AI scene previews: Draft shots made by the Generate shot jobs (generateStore, backend
// data/generations.json), each with its own seed, saved to the library tagged with their project
// and scene. The project keeps its own record of each one (seed, prompt, last job state) and
// follows the jobs list to update it, so a preview's state is saved with the project and outlives
// the job. These changes are not on the undo history: a preview only goes when you delete it.
// Finals (sceneFinals.ts) are followed the same way, here.
import { api, type LibraryItem, type ShotJob } from '../../lib/api'
import { newId } from '../../lib/ids'
import { updateProject, useProjectStore } from '../../state/project/store'
import type { PreviewStatus, SceneFinal, ScenePreview } from '../../state/project/types'
import { cancelShot, generateShots, useGenerate } from '../generate/generateStore'
import { deleteItem, useLibrary } from '../library/libraryStore'
import { previewSeconds } from './sceneOps'

export const PREVIEW_STATUS_LABEL: Record<PreviewStatus, string> = {
  queued: 'Queued',
  running: 'Generating',
  saving: 'Generating',
  done: 'Completed',
  error: 'Failed',
  cancelled: 'Cancelled',
}

const ACTIVE: readonly PreviewStatus[] = ['queued', 'running', 'saving']
export const isPreviewActive = (preview: Pick<ScenePreview, 'status'>) => ACTIVE.includes(preview.status)

/** A job missing from the jobs list this long is gone (not just a list fetched before it was made). */
export const GONE_AFTER_MS = 20_000
export const GONE_MESSAGE = 'The app no longer has this preview’s job (its list was cleared or lost), and no clip was saved. Retry makes it again.'
export const FINAL_GONE_MESSAGE = 'The app no longer has this final’s job (its list was cleared or lost), and no clip was saved. Retry makes it again.'

const currentProject = () => useProjectStore.getState().project

function fromJob(job: ShotJob, sceneId: string): ScenePreview {
  return {
    id: newId('v'),
    sceneId,
    jobId: job.id,
    seed: job.seed,
    prompt: job.prompt,
    duration: job.duration,
    status: job.status,
    error: job.error,
    itemId: job.itemId,
    createdAt: job.createdAt,
  }
}

/**
 * "Generate previews": the scene's previews count of Draft shots, each with its own random seed,
 * as long as the scene (rounded up to whole seconds, 2 to 5). They're added to the scene's
 * previews; none are replaced. Returns their ids. Throws with the reason (no prompt, ComfyUI
 * isn't open, …).
 */
export async function generatePreviews(sceneId: string): Promise<string[]> {
  const project = currentProject()
  const scene = project.scenes.find((s) => s.id === sceneId)
  if (!scene) return []
  const prompt = scene.prompt.trim()
  if (!prompt) throw new Error('Write the ComfyUI prompt first: it says what the preview shows.')
  const jobs = await generateShots({
    prompt,
    duration: previewSeconds(scene),
    quality: 'draft',
    variations: scene.previewCount,
    scene: { projectId: project.id, sceneId },
  })
  // Another project was opened meanwhile: the clips still go to the library (tagged with this one).
  if (currentProject().id !== project.id) return []
  const made = jobs.map((job) => fromJob(job, sceneId))
  updateProject((p) => {
    p.scenePreviews.push(...made)
  })
  return made.map((preview) => preview.id)
}

/** Forgets a finished job in the backend's list (quietly: it's only tidying up). */
export function dismissJob(jobId: string) {
  api
    .dismissShot(jobId)
    .then(() => useGenerate.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== jobId) })))
    .catch(() => undefined)
}

/**
 * Retry on a failed (or cancelled) preview: the same prompt, seed and length again, as a new job.
 * Only that preview changes; the scene, its other previews and every other scene stay as they are.
 */
export async function retryPreview(previewId: string): Promise<void> {
  const project = currentProject()
  const preview = project.scenePreviews.find((p) => p.id === previewId)
  if (!preview || isPreviewActive(preview) || preview.status === 'done') return
  const [job] = await generateShots({
    prompt: preview.prompt,
    duration: preview.duration,
    quality: 'draft',
    variations: 1,
    seed: preview.seed,
    scene: { projectId: project.id, sceneId: preview.sceneId },
  })
  if (currentProject().id !== project.id) return
  updateProject((p) => {
    const target = p.scenePreviews.find((x) => x.id === previewId)
    if (target) Object.assign(target, { jobId: job.id, status: job.status, error: job.error, itemId: null })
  })
  forgetMissing(preview.jobId)
  dismissJob(preview.jobId)
}

export function cancelPreview(previewId: string) {
  const preview = currentProject().scenePreviews.find((p) => p.id === previewId)
  if (preview && isPreviewActive(preview)) void cancelShot(preview.jobId)
}

/**
 * Deletes a finished preview: its clip goes from the library (after asking), and it goes from
 * its scene. If it was the scene's chosen preview, the scene has none chosen.
 */
export async function deletePreview(previewId: string): Promise<void> {
  const preview = currentProject().scenePreviews.find((p) => p.id === previewId)
  if (!preview || isPreviewActive(preview)) return
  const item = preview.itemId ? useLibrary.getState().items.find((i) => i.id === preview.itemId) : undefined
  if (item && !(await deleteItem(item.id))) return
  updateProject((p) => {
    p.scenePreviews = p.scenePreviews.filter((x) => x.id !== previewId)
    // Not an undo step (the clip is gone for good); an older step pointing at it shows no choice.
    for (const scene of p.scenes) if (scene.selectedPreviewId === previewId) scene.selectedPreviewId = null
  })
  dismissJob(preview.jobId)
}

// Following the jobs ------------------------------------------------------------------------------

/** When each job was first missing from the jobs list (see GONE_AFTER_MS). */
const missingSince = new Map<string, number>()

/** A retried record has a new job: the old one's absence means nothing. */
export const forgetMissing = (jobId: string) => missingSince.delete(jobId)

/** A preview or final: the project's record of a job and what it made. */
type JobRecord = Pick<ScenePreview, 'jobId' | 'status' | 'error' | 'itemId'>

/**
 * The records with their latest state from the jobs list, or null when nothing changed. A job
 * that's no longer listed (the list was cleared, or pruned while the project was closed) leaves
 * its record as it was if it had finished; one still running is looked up in the library by the
 * job id its clip was saved with, and otherwise marked failed (`gone`) once it's been missing a
 * while. `library` is null while the library isn't loaded.
 */
export function syncRecords<T extends JobRecord>(
  records: readonly T[],
  jobs: readonly ShotJob[],
  library: readonly LibraryItem[] | null,
  now: number,
  gone: string,
): T[] | null {
  const byId = new Map(jobs.map((job) => [job.id, job]))
  let changed = false
  const result = records.map((record) => {
    const job = byId.get(record.jobId)
    let next: Pick<JobRecord, 'status' | 'error' | 'itemId'> | null = null
    if (job) {
      missingSince.delete(record.jobId)
      next = { status: job.status, error: job.error, itemId: job.itemId ?? record.itemId }
    } else if (isPreviewActive(record) && library) {
      const item = library.find((i) => i.generation?.shotId === record.jobId)
      const since = missingSince.get(record.jobId) ?? now
      missingSince.set(record.jobId, since)
      if (item) next = { status: 'done', error: null, itemId: item.id }
      else if (now - since >= GONE_AFTER_MS) next = { status: 'error', error: gone, itemId: null }
    }
    if (!next || (next.status === record.status && next.error === record.error && next.itemId === record.itemId)) return record
    changed = true
    return { ...record, ...next }
  })
  return changed ? result : null
}

/** The previews with their latest state from the jobs list, or null when nothing changed. */
export const syncPreviews = (
  previews: readonly ScenePreview[],
  jobs: readonly ShotJob[],
  library: readonly LibraryItem[] | null,
  now: number = Date.now(),
) => syncRecords(previews, jobs, library, now, GONE_MESSAGE)

/** The finals with their latest state from the jobs list, or null when nothing changed. */
export const syncFinals = (
  finals: readonly SceneFinal[],
  jobs: readonly ShotJob[],
  library: readonly LibraryItem[] | null,
  now: number = Date.now(),
) => syncRecords(finals, jobs, library, now, FINAL_GONE_MESSAGE)

function syncNow() {
  const { project, loaded } = useProjectStore.getState()
  const { jobs, listed } = useGenerate.getState()
  if (!loaded || !listed || (!project.scenePreviews.length && !project.sceneFinals.length)) return
  const { items, status } = useLibrary.getState()
  const library = status === 'ready' ? items : null
  const previews = syncPreviews(project.scenePreviews, jobs, library)
  const finals = syncFinals(project.sceneFinals, jobs, library)
  if (previews || finals) {
    updateProject((p) => {
      if (previews) p.scenePreviews = previews
      if (finals) p.sceneFinals = finals
    })
  }
}

let following = false

/** Keeps the open project's previews and finals in step with the jobs list. Runs once, from App. */
export function followPreviewJobs() {
  if (following) return
  following = true
  useGenerate.subscribe((state, previous) => {
    if (state.jobs !== previous.jobs || state.listed !== previous.listed) syncNow()
  })
  useLibrary.subscribe((state, previous) => {
    if (state.items !== previous.items || state.status !== previous.status) syncNow()
  })
  useProjectStore.subscribe((state, previous) => {
    const { project } = state
    if (project.scenePreviews !== previous.project.scenePreviews || project.sceneFinals !== previous.project.sceneFinals || state.loaded !== previous.loaded) syncNow()
  })
  syncNow()
}

/**
 * What a scene's status line says about one preview, e.g. "Scene 3: preview 2 of 2, seed 123456,
 * 62%". The percentage is the job's own progress; a queued preview says how many are ahead of it.
 */
export function previewStatusLine(sceneNumber: number, index: number, count: number, preview: ScenePreview, job?: ShotJob): string {
  const head = `Scene ${sceneNumber}: preview ${index} of ${count}, seed ${preview.seed}`
  const status = job?.status ?? preview.status
  if (status === 'running' || status === 'saving') return `${head}, ${Math.round((job?.progress ?? 0) * 100)}%`
  if (status === 'queued') {
    const ahead = job?.queuePosition
    return `${head}, queued${ahead ? ` (${ahead} ahead)` : ''}`
  }
  return `${head}, ${PREVIEW_STATUS_LABEL[status].toLowerCase()}`
}
