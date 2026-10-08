// The render: checks before it starts, drawing the text overlays, the backend job, cancel and
// the finished file. It runs in the background: closing the dialog doesn't stop it, and the
// Render button in the top bar shows its progress.
import { create } from 'zustand'
import { api, ApiError, type RenderCheck, type RenderQuality, type RenderResult } from '../../lib/api'
import { waitForJob } from '../../lib/jobs'
import { useProjectStore } from '../../state/project/store'
import { drawOverlayImages } from './overlayFrames'

export type RenderStage = 'idle' | 'checking' | 'review' | 'preparing' | 'rendering' | 'done' | 'error'

interface RenderState {
  open: boolean
  stage: RenderStage
  check: RenderCheck | null
  quality: RenderQuality['id']
  /** 0..1 over the whole render (drawing the overlays is the first few percent). */
  progress: number
  message: string
  startedAt: number | null
  finishedAt: number | null
  jobId: string | null
  result: RenderResult | null
  error: string | null
  /** Shown above the checks, e.g. after a cancelled render. */
  notice: string | null
}

export const useRender = create<RenderState>()(() => ({
  open: false,
  stage: 'idle',
  check: null,
  quality: 'best',
  progress: 0,
  message: '',
  startedAt: null,
  finishedAt: null,
  jobId: null,
  result: null,
  error: null,
  notice: null,
}))

const set = useRender.setState
/** Share of the progress bar for drawing the text overlays. */
const OVERLAY_SHARE = 0.05

let controller: AbortController | null = null

export const isRendering = (stage: RenderStage) => stage === 'preparing' || stage === 'rendering'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function openRenderDialog() {
  const { stage } = useRender.getState()
  set({ open: true })
  if (!isRendering(stage) && stage !== 'done' && stage !== 'checking') void checkProject()
}

export function closeRenderDialog() {
  set({ open: false })
}

/** Checks the project as it is in the editor now. */
export async function checkProject(notice: string | null = null) {
  set({ stage: 'checking', notice, error: null, result: null })
  try {
    const check = await api.renderCheck(useProjectStore.getState().project)
    const { quality } = useRender.getState()
    set({
      stage: 'review',
      check,
      quality: check.qualities.some((q) => q.id === quality) ? quality : 'best',
    })
  } catch (error) {
    set({ stage: 'error', error: message(error) })
  }
}

export function setQuality(quality: RenderQuality['id']) {
  set({ quality })
}

export async function startRender() {
  const project = useProjectStore.getState().project
  const abort = new AbortController()
  controller = abort
  set({ stage: 'preparing', progress: 0, message: 'Drawing the text…', startedAt: Date.now(), finishedAt: null, jobId: null, notice: null })
  try {
    // Checked again so the overlays match the timeline exactly as it is now.
    const check = await api.renderCheck(project)
    if (check.blockers.length) throw new Error(check.blockers.join(' '))
    set({ check })
    const overlays = await drawOverlayImages(
      project,
      check.frames,
      check.fps,
      (share) => set({ progress: share * OVERLAY_SHARE }),
      abort.signal,
    )
    if (abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    set({ message: 'Sending the project to FFmpeg…' })
    const job = await api.startRender(
      { project, quality: useRender.getState().quality, fps: { num: check.fps.num, den: check.fps.den }, frames: check.frames },
      overlays.manifest,
      overlays.data,
    )
    set({ stage: 'rendering', jobId: job.id })
    if (abort.signal.aborted) {
      await api.cancelRender(job.id).catch(() => undefined)
      throw new DOMException('Cancelled', 'AbortError')
    }
    const result = await waitForJob(
      job,
      (update) => set({ progress: OVERLAY_SHARE + update.progress * (1 - OVERLAY_SHARE), message: update.message }),
      abort.signal,
    )
    set({ stage: 'done', result, progress: 1, finishedAt: Date.now(), jobId: null, open: true })
  } catch (error) {
    if (abort.signal.aborted) {
      set({ jobId: null })
      void checkProject('Render cancelled. The partial file was deleted.')
    } else {
      set({ stage: 'error', error: message(error), jobId: null, finishedAt: Date.now() })
    }
  } finally {
    if (controller === abort) controller = null
  }
}

export async function cancelRender() {
  const { jobId } = useRender.getState()
  controller?.abort()
  set({ message: 'Cancelling…' })
  if (jobId) {
    try {
      await api.cancelRender(jobId)
    } catch (error) {
      // It finished just before the cancel arrived.
      if (!(error instanceof ApiError && error.status === 404)) console.warn('Cancel failed:', error)
    }
  }
}

export async function openResult(action: 'play' | 'folder') {
  const { result } = useRender.getState()
  if (!result) return
  try {
    await api.openRender(result.file, action)
  } catch (error) {
    set({ notice: message(error) })
  }
}
