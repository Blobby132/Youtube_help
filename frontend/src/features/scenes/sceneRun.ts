// The AI scenes' generation run: what the Scenes tab's progress panel follows. "Generate all
// previews" and "Generate all finals" start one, a step per scene; a scene's own Generate
// previews or Generate final joins it while it's running (else starts a new one). Every job
// still goes through the Generate shot jobs and ComfyUI's queue, which runs them one at a time.
// A step that fails shows its error and a Retry for that scene only; the others keep going.
// The run is saved with the project, outside the undo history.
import type { ShotJob } from '../../lib/api'
import { newId } from '../../lib/ids'
import { updateProject, useProjectStore } from '../../state/project/store'
import type { GenerationRun, Project, RunStep, Scene, SceneFinal, ScenePreview } from '../../state/project/types'
import { finalOf } from './sceneOps'
import { generateFinal, retryFinal } from './sceneFinals'
import { generatePreviews, isPreviewActive, retryPreview } from './scenePreviews'

type Records = Pick<Project, 'scenes' | 'scenePreviews' | 'sceneFinals'>
type Kind = RunStep['kind']

const currentProject = () => useProjectStore.getState().project
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function recordsOf(step: RunStep, project: Records): (ScenePreview | SceneFinal)[] {
  const all: readonly (ScenePreview | SceneFinal)[] = step.kind === 'previews' ? project.scenePreviews : project.sceneFinals
  return step.recordIds.flatMap((id) => all.filter((r) => r.id === id))
}

/** Whether anything in the run is still being sent to ComfyUI or made by it. */
export function runActive(run: GenerationRun | null, project: Records): boolean {
  return !!run?.steps.some((step) => (!step.recordIds.length && !step.error) || recordsOf(step, project).some(isPreviewActive))
}

// What the panel shows ----------------------------------------------------------------------------

export type StepState = 'starting' | 'queued' | 'running' | 'done' | 'error'

export interface StepView {
  sceneId: string
  /** The scene's number (its position in the list). */
  number: number
  kind: Kind
  state: StepState
  /** 0..1, over its jobs. */
  progress: number
  /** How many jobs it counts for in the total. */
  jobs: number
  /** e.g. "Previews: 1 of 2 done, generating 45%", "Final: queued (2 ahead)". */
  text: string
  error: string | null
}

export interface RunView {
  steps: StepView[]
  /** 0..1 over every job in the run; a failed one counts as not done until it's retried. */
  total: number
  active: boolean
  failed: number
}

function stepView(step: RunStep, number: number, project: Records, jobs: ReadonlyMap<string, ShotJob>): StepView {
  const name = step.kind === 'previews' ? 'Previews' : 'Final'
  const records = recordsOf(step, project)
  const base = { sceneId: step.sceneId, number, kind: step.kind }
  if (!records.length) {
    if (step.error) return { ...base, state: 'error', progress: 0, jobs: 1, text: `${name}: couldn’t start`, error: step.error }
    return { ...base, state: 'starting', progress: 0, jobs: 1, text: `${name}: sending to ComfyUI…`, error: null }
  }
  const live = records.map((record) => {
    const job = jobs.get(record.jobId)
    const status = job?.status ?? record.status
    const progress = status === 'done' ? 1 : status === 'running' || status === 'saving' ? (job?.progress ?? 0) : 0
    return { record, job, status, progress }
  })
  const progress = live.reduce((sum, r) => sum + r.progress, 0) / live.length
  const running = live.find((r) => r.status === 'running' || r.status === 'saving')
  const queued = live.filter((r) => r.status === 'queued')
  const failed = live.filter((r) => r.status === 'error' || r.status === 'cancelled')
  const done = live.filter((r) => r.status === 'done').length
  const state: StepState = running ? 'running' : queued.length ? 'queued' : failed.length ? 'error' : 'done'
  const ahead = queued.map((r) => r.job?.queuePosition ?? 0).filter((n) => n > 0)
  const doing = running
    ? `generating ${Math.round(running.progress * 100)}%`
    : queued.length
      ? `queued${ahead.length ? ` (${Math.min(...ahead)} ahead)` : ''}`
      : ''
  let text: string
  if (step.kind === 'final') {
    text = `Final: ${doing || (state === 'done' ? 'done' : failed[0]?.status === 'cancelled' ? 'cancelled' : 'failed')}`
  } else {
    const parts = [`${done} of ${live.length} done`, doing, failed.length ? `${failed.length} failed` : ''].filter(Boolean)
    text = `Previews: ${parts.join(', ')}`
  }
  const error =
    state === 'error' ? (step.error ?? failed.map((r) => r.job?.error ?? r.record.error).find(Boolean) ?? (failed[0]?.status === 'cancelled' ? 'Cancelled.' : null)) : null
  return { ...base, state, progress, jobs: live.length, text, error }
}

/** The panel's lines, in scene order (previews before the final), and the total. Steps whose
 * scene is gone are left out. */
export function runView(run: GenerationRun, project: Records, jobs: ReadonlyMap<string, ShotJob>): RunView {
  const numbers = new Map(project.scenes.map((scene, i) => [scene.id, i + 1]))
  const steps = run.steps
    .filter((step) => numbers.has(step.sceneId))
    .map((step) => stepView(step, numbers.get(step.sceneId)!, project, jobs))
    .sort((a, b) => a.number - b.number || (a.kind === b.kind ? 0 : a.kind === 'previews' ? -1 : 1))
  const count = steps.reduce((sum, s) => sum + s.jobs, 0)
  return {
    steps,
    total: count ? steps.reduce((sum, s) => sum + s.progress * s.jobs, 0) / count : 0,
    active: steps.some((s) => s.state === 'starting' || s.state === 'queued' || s.state === 'running'),
    failed: steps.filter((s) => s.state === 'error').length,
  }
}

// What the buttons do -----------------------------------------------------------------------------

const aiScenes = (project: Records) => project.scenes.filter((s) => s.source === 'ai')

/** AI scenes "Generate all previews" makes previews for: the ones that have none. */
export const scenesWithoutPreviews = (project: Records) =>
  aiScenes(project).filter((scene) => !project.scenePreviews.some((p) => p.sceneId === scene.id))

/** A scene's chosen preview, when it's finished. */
function chosenPreview(scene: Scene, project: Records) {
  return project.scenePreviews.find((p) => p.id === scene.selectedPreviewId && p.sceneId === scene.id && p.status === 'done')
}

/** AI scenes "Generate all finals" makes finals for: the ones without a final (made or being made)
 * from their chosen preview. */
export function scenesNeedingFinals(project: Records): Scene[] {
  return aiScenes(project).filter((scene) => {
    const final = finalOf(project.sceneFinals, scene.id)
    return !final || final.previewId !== scene.selectedPreviewId || !(final.status === 'done' || isPreviewActive(final))
  })
}

const list = (numbers: number[]) =>
  numbers.length === 1 ? `scene ${numbers[0]}` : `scenes ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`

/** Why "Generate all finals" isn't available (null when it is): every AI scene needs a chosen,
 * finished preview first. It never chooses one for you. */
export function allFinalsBlocker(project: Records): string | null {
  const scenes = aiScenes(project)
  if (!scenes.length) return 'There are no AI scenes.'
  const unchosen = scenes.filter((scene) => !chosenPreview(scene, project)).map((scene) => project.scenes.indexOf(scene) + 1)
  if (unchosen.length) return `Choose a preview (Use this) for ${list(unchosen)} first.`
  if (!scenesNeedingFinals(project).length) return 'Every AI scene has its final. Regenerate final on a scene makes it again.'
  return null
}

/** Why "Generate all previews" isn't available (null when it is). */
export function allPreviewsBlocker(project: Records): string | null {
  if (!aiScenes(project).length) return 'There are no AI scenes.'
  if (!scenesWithoutPreviews(project).length) return 'Every AI scene has previews. Generate previews on a scene adds more.'
  return null
}

/**
 * Adds steps to the run, or starts a new run with them when there's none or it has finished. A
 * step for a scene already in a running run takes the place of its step of that kind (previews
 * add to it).
 */
function addSteps(steps: RunStep[]) {
  updateProject((p) => {
    const run = p.generationRun
    if (!run || !runActive(run, p)) {
      p.generationRun = { id: newId('r'), steps }
      return
    }
    for (const step of steps) {
      const index = run.steps.findIndex((s) => s.sceneId === step.sceneId && s.kind === step.kind)
      if (index < 0) run.steps.push(step)
      else if (step.kind === 'previews' && step.recordIds.length) {
        const old = run.steps[index]
        run.steps[index] = { ...step, recordIds: [...(old.error ? [] : old.recordIds), ...step.recordIds] }
      } else run.steps[index] = step
    }
  })
}

function setStep(runId: string, sceneId: string, kind: Kind, patch: Partial<RunStep>) {
  updateProject((p) => {
    const step = p.generationRun?.id === runId ? p.generationRun.steps.find((s) => s.sceneId === sceneId && s.kind === kind) : undefined
    if (step) Object.assign(step, patch)
  })
}

/** Sends each scene's step to ComfyUI, one scene after another, noting what each one made or
 * why it couldn't start. Stops if another project is opened. */
async function runSteps(scenes: Scene[], kind: Kind, start: (scene: Scene) => Promise<string[]>) {
  const projectId = currentProject().id
  addSteps(scenes.map((scene) => ({ sceneId: scene.id, kind, recordIds: [], error: null })))
  const runId = currentProject().generationRun?.id ?? ''
  for (const scene of scenes) {
    if (currentProject().id !== projectId) return
    try {
      const recordIds = await start(scene)
      setStep(runId, scene.id, kind, { recordIds, error: null })
    } catch (error) {
      setStep(runId, scene.id, kind, { error: message(error) })
    }
  }
}

const finalIds = async (sceneId: string, regenerate = false) => {
  const id = await generateFinal(sceneId, regenerate)
  return id ? [id] : []
}

/** "Generate all previews": previews for every AI scene that has none. Chooses none of them. */
export async function generateAllPreviews(): Promise<void> {
  const scenes = scenesWithoutPreviews(currentProject())
  if (scenes.length) await runSteps(scenes, 'previews', (scene) => generatePreviews(scene.id))
}

/**
 * "Generate all finals" (once every AI scene has a chosen preview): a final for each AI scene
 * that has none from its chosen preview. A failed one from that preview is retried.
 */
export async function generateAllFinals(): Promise<void> {
  const project = currentProject()
  if (allFinalsBlocker(project)) return
  await runSteps(scenesNeedingFinals(project), 'final', async (scene) => {
    const final = finalOf(currentProject().sceneFinals, scene.id)
    if (final && final.previewId === scene.selectedPreviewId && !isPreviewActive(final) && final.status !== 'done') {
      await retryFinal(final.id)
      return [final.id]
    }
    return finalIds(scene.id)
  })
}

/** A scene's own Generate previews: joins the run. Throws with the reason it couldn't start. */
export async function generateScenePreviews(sceneId: string): Promise<void> {
  const ids = await generatePreviews(sceneId)
  if (ids.length) addSteps([{ sceneId, kind: 'previews', recordIds: ids, error: null }])
}

/** A scene's own Generate final or Regenerate final: joins the run. Throws with the reason. */
export async function generateSceneFinal(sceneId: string, regenerate = false): Promise<void> {
  const ids = await finalIds(sceneId, regenerate)
  if (ids.length) addSteps([{ sceneId, kind: 'final', recordIds: ids, error: null }])
}

/** The panel's Retry for one scene: what failed in its step is made again; nothing else changes. */
export async function retryStep(sceneId: string, kind: Kind): Promise<void> {
  const run = currentProject().generationRun
  const step = run?.steps.find((s) => s.sceneId === sceneId && s.kind === kind)
  if (!run || !step) return
  setStep(run.id, sceneId, kind, { error: null })
  try {
    if (!step.recordIds.length) {
      const recordIds = kind === 'previews' ? await generatePreviews(sceneId) : await finalIds(sceneId)
      setStep(run.id, sceneId, kind, { recordIds })
      return
    }
    for (const record of recordsOf(step, currentProject())) {
      if (record.status !== 'error' && record.status !== 'cancelled') continue
      if (kind === 'previews') await retryPreview(record.id)
      else await retryFinal(record.id)
    }
  } catch (error) {
    setStep(run.id, sceneId, kind, { error: message(error) })
  }
}

/** Closes the panel once the run has finished. */
export function closeRun() {
  updateProject((p) => {
    if (!runActive(p.generationRun, p)) p.generationRun = null
  })
}
