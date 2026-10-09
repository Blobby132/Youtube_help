// The language model on this PC (LM Studio, Ollama, …): its status, and its runs from the Scenes
// tab, "Write scenes with AI" and "Rewrite prompt". Runs go through the backend (POST /api/llm/…),
// which keeps them off the GPU while ComfyUI works and unloads the model afterwards; a run's answer
// for scenes waits here (`pending`) until it's applied or discarded, so closing the review dialog
// loses nothing.
import { create } from 'zustand'
import { api, type LlmStatus, type ShotJob, type WriteResult } from '../../lib/api'
import { JobError, waitForJob } from '../../lib/jobs'
import { useProjectStore } from '../../state/project/store'
import type { Scene } from '../../state/project/types'
import { checkComfy } from '../generate/generateStore'
import { editScenes } from '../timeline/timelineEdits'
import { applyWrite, type Choices, defaultChoices, needsAnswers, promptRequest, reviewWrite, writeRequest, writeSummary } from './aiWrite'
import { updateScene } from './sceneEdits'
import { isEdited } from './sceneOps'

/** What a failed run says, and what the model wrote (its raw answers), if it got that far. */
export interface Failure {
  message: string
  raw: string[]
}

interface Run {
  kind: 'scenes' | 'prompt'
  /** Rewrite prompt: the scene. */
  sceneId: string | null
  progress: number
  message: string
}

interface Pending {
  projectId: string
  /** The scenes as they were sent, to see what changed while the model wrote. */
  sent: Scene[]
  result: WriteResult
  choices: Choices
}

interface LlmState {
  status: LlmStatus | null
  checking: boolean
  run: Run | null
  pending: Pending | null
  reviewOpen: boolean
  /** The last Write scenes: what it did, what it left out, and what happened on the GPU. */
  done: { message: string; skipped: string[]; notes: string[] } | null
  failure: Failure | null
  /** Rewrite prompt failures, by scene id. */
  promptFailures: Record<string, Failure>
}

export const useLlm = create<LlmState>()(() => ({
  status: null,
  checking: false,
  run: null,
  pending: null,
  reviewOpen: false,
  done: null,
  failure: null,
  promptFailures: {},
}))

// Another project: the last one's answer, results and failures aren't about it.
let projectId = useProjectStore.getState().project.id
useProjectStore.subscribe((state) => {
  if (state.project.id === projectId) return
  projectId = state.project.id
  useLlm.setState({ pending: null, reviewOpen: false, done: null, failure: null, promptFailures: {} })
})

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const rawOf = (error: unknown) => {
  const raw = error instanceof JobError ? error.data?.raw : undefined
  return Array.isArray(raw) ? raw.map(String) : []
}
const currentProject = () => useProjectStore.getState().project

export const SHARED_GPU = 'The language model and ComfyUI share the GPU, and running both at once can run out of video memory or slow both to a crawl.'

export async function checkLlm() {
  useLlm.setState({ checking: true })
  try {
    useLlm.setState({ status: await api.llmStatus(), checking: false })
  } catch (error) {
    // The backend itself isn't answering: say so like an unreachable server.
    useLlm.setState((s) => ({
      checking: false,
      status: s.status ? { ...s.status, reachable: false, error: message(error) } : null,
    }))
  }
}

/** ComfyUI jobs the app knows are in ComfyUI's queue (it knows before the next status check). */
export const comfyJobsActive = (jobs: readonly ShotJob[]) => jobs.filter((job) => job.status === 'queued' || job.status === 'running').length

/** Why the language model can't run now (null when it can). */
export function llmBlocker(status: LlmStatus | null, online: boolean, comfyJobs: number): string | null {
  if (!online) return 'The backend is not running.'
  if (!status) return 'Checking the language model…'
  if (!status.reachable) return 'Start the language model server first (LM Studio or Ollama): Write with AI uses it.'
  if (status.modelProblem) return status.modelProblem
  if (status.guideProblem) return status.guideProblem
  if (status.comfy.busy) return status.comfy.busy
  if (comfyJobs) {
    return `ComfyUI is generating (${comfyJobs} ${comfyJobs === 1 ? 'job' : 'jobs'} in its queue), so the language model waits until it's done. ${SHARED_GPU}`
  }
  return null
}

function progress(kind: Run['kind'], sceneId: string | null) {
  return (job: { progress: number; message: string }) => useLlm.setState({ run: { kind, sceneId, progress: job.progress, message: job.message } })
}

/** After a run (or its refusal): the model and ComfyUI's buttons are free again. */
function settle() {
  useLlm.setState({ run: null })
  void checkLlm()
  void checkComfy()
}

// Write scenes with AI ----------------------------------------------------------------------------

/**
 * Asks the language model to write every scene. What it writes goes into the fields you haven't
 * edited; if it has text for ones you have, or suggests merging or splitting scenes, the review
 * dialog asks first. Either way it's one undo step.
 */
export async function writeScenesWithAi(): Promise<void> {
  const project = currentProject()
  if (!project.scenes.length || useLlm.getState().run) return
  const sent = project.scenes
  useLlm.setState({ run: { kind: 'scenes', sceneId: null, progress: 0, message: 'Starting…' }, failure: null, done: null, pending: null })
  try {
    const job = await api.writeScenes(writeRequest(project))
    void checkComfy() // ComfyUI's buttons wait while it runs
    const result = await waitForJob(job, progress('scenes', null))
    if (currentProject().id !== project.id) return // another project was opened meanwhile
    const review = reviewWrite(currentProject().scenes, sent, result)
    const pending = { projectId: project.id, sent, result, choices: defaultChoices(review) }
    if (needsAnswers(review)) useLlm.setState({ pending, reviewOpen: true })
    else finishWrite(pending)
  } catch (error) {
    useLlm.setState({ failure: { message: message(error), raw: rawOf(error) } })
  } finally {
    settle()
  }
}

function finishWrite(pending: Pending) {
  const review = reviewWrite(currentProject().scenes, pending.sent, pending.result)
  editScenes((scenes) => applyWrite(scenes, review, pending.choices))
  useLlm.setState({
    pending: null,
    reviewOpen: false,
    done: { message: writeSummary(pending.result, review, pending.choices), skipped: review.skipped, notes: pending.result.notes },
  })
}

/** The review dialog's Apply: the AI's text, with your answers. */
export function applyReview() {
  const { pending } = useLlm.getState()
  if (pending && pending.projectId === currentProject().id) finishWrite(pending)
  else useLlm.setState({ pending: null, reviewOpen: false })
}

/** The review dialog's Discard: nothing changes. */
export function discardReview() {
  useLlm.setState({ pending: null, reviewOpen: false })
}

export const openReview = () => useLlm.setState({ reviewOpen: true })
export const closeReview = () => useLlm.setState({ reviewOpen: false })

/** Ticks or unticks one answer in the review dialog. */
export function setChoice(list: keyof Choices, key: string, on: boolean) {
  useLlm.setState((s) => {
    if (!s.pending) return {}
    const keys = s.pending.choices[list].filter((k) => k !== key)
    return { pending: { ...s.pending, choices: { ...s.pending.choices, [list]: on ? [...keys, key] : keys } } }
  })
}

// Rewrite prompt ----------------------------------------------------------------------------------

function setPromptFailure(sceneId: string, failure: Failure | null) {
  useLlm.setState((s) => {
    const promptFailures = { ...s.promptFailures }
    if (failure) promptFailures[sceneId] = failure
    else delete promptFailures[sceneId]
    return { promptFailures }
  })
}

/**
 * "Rewrite prompt": a new ComfyUI prompt for one scene, from its narration, description and
 * current prompt, by prompts/ltx_guide.md. A prompt with your own text is only replaced after
 * asking (before the run, and again if you changed it while the model wrote). One undo step.
 */
export async function rewriteScenePrompt(sceneId: string): Promise<void> {
  const project = currentProject()
  const index = project.scenes.findIndex((s) => s.id === sceneId)
  const scene = project.scenes[index]
  const body = promptRequest(project, sceneId)
  if (!scene || !body || useLlm.getState().run) return
  if (isEdited(scene, 'prompt') && !window.confirm(`Scene ${index + 1}’s prompt has your own text. Rewrite it with the language model? Undo (Ctrl+Z) brings yours back.`)) return
  setPromptFailure(sceneId, null)
  useLlm.setState({ run: { kind: 'prompt', sceneId, progress: 0, message: 'Starting…' } })
  try {
    const job = await api.rewritePrompt(body)
    void checkComfy()
    const result = await waitForJob(job, progress('prompt', sceneId))
    if (currentProject().id !== project.id) return
    const now = currentProject().scenes.find((s) => s.id === sceneId)
    if (!now) return
    const changed = now.prompt !== scene.prompt && isEdited(now, 'prompt')
    if (changed && !window.confirm('You changed this scene’s prompt while the language model was writing. Replace it with the new one?')) return
    updateScene(sceneId, { prompt: result.prompt, aiWritten: { ...now.aiWritten, prompt: result.prompt } })
  } catch (error) {
    setPromptFailure(sceneId, { message: message(error), raw: rawOf(error) })
  } finally {
    settle()
  }
}
