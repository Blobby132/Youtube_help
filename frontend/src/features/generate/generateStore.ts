// Generate shot: ComfyUI's status and the shots being made. The jobs live in the backend
// (data/generations.json), so this store just mirrors them; a page reload loses nothing.
import { create } from 'zustand'
import { api, type ComfyStatus, type ShotJob, type ShotRequest } from '../../lib/api'
import { loadLibrary, useLibrary } from '../library/libraryStore'

interface GenerateState {
  status: ComfyStatus | null
  checking: boolean
  jobs: ShotJob[]
  /** True once the jobs list has come from the backend (until then `jobs` may be incomplete). */
  listed: boolean
  /** Why the last list, cancel or generate request failed. */
  error: string | null
}

export const useGenerate = create<GenerateState>()(() => ({ status: null, checking: false, jobs: [], listed: false, error: null }))

const ACTIVE = new Set(['queued', 'running', 'saving'])
const FAST_MS = 1500
const SLOW_MS = 15000

export const isActive = (job: ShotJob) => ACTIVE.has(job.status)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function checkComfy() {
  useGenerate.setState({ checking: true })
  try {
    useGenerate.setState({ status: await api.comfyStatus(), checking: false })
  } catch (error) {
    useGenerate.setState({ checking: false, error: message(error) })
  }
}

function applyJobs(jobs: ShotJob[]) {
  const before = new Map(useGenerate.getState().jobs.map((j) => [j.id, j.status]))
  useGenerate.setState({ jobs, listed: true, error: null })
  // A shot just landed in the library: show it there.
  const items = new Set(useLibrary.getState().items.map((i) => i.id))
  if (jobs.some((j) => j.status === 'done' && j.itemId && !items.has(j.itemId) && before.get(j.id) !== 'done')) {
    void loadLibrary()
  }
}

export async function refreshShots() {
  try {
    applyJobs((await api.listShots()).jobs)
  } catch (error) {
    useGenerate.setState({ error: message(error) })
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
let polling = false

/** Keeps the jobs list current: every 1.5 s while shots are being made, else every 15 s. */
export function startShotPolling() {
  if (polling) return
  polling = true
  const tick = async () => {
    await refreshShots()
    const busy = useGenerate.getState().jobs.some(isActive)
    timer = setTimeout(() => void tick(), busy ? FAST_MS : SLOW_MS)
  }
  void tick()
}

function pollSoon() {
  clearTimeout(timer)
  timer = setTimeout(() => {
    polling = false
    startShotPolling()
  }, 200)
}

/** Queues shots; throws with the backend's reason (e.g. ComfyUI isn't open). */
export async function generateShots(shot: ShotRequest): Promise<ShotJob[]> {
  const { jobs } = await api.generateShots(shot)
  useGenerate.setState((s) => ({ jobs: [...jobs, ...s.jobs.filter((j) => !jobs.some((n) => n.id === j.id))] }))
  pollSoon()
  return jobs
}

export async function cancelShot(jobId: string) {
  try {
    const job = await api.cancelShot(jobId)
    useGenerate.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === jobId ? job : j)) }))
    pollSoon()
  } catch (error) {
    useGenerate.setState({ error: `Could not cancel: ${message(error)}` })
  }
}

export async function dismissShot(jobId: string) {
  try {
    await api.dismissShot(jobId)
    useGenerate.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== jobId) }))
  } catch (error) {
    useGenerate.setState({ error: message(error) })
  }
}

export async function clearFinishedShots() {
  try {
    applyJobs((await api.clearShots()).jobs)
  } catch (error) {
    useGenerate.setState({ error: message(error) })
  }
}

/** Why Generate shot can't be used right now (null when it can). */
export function generateBlocker(status: ComfyStatus | null, online: boolean): string | null {
  if (!online) return 'The backend is not running.'
  if (!status) return 'Checking ComfyUI…'
  if (status.workflowProblem) return status.workflowProblem
  if (!status.reachable) return 'Open ComfyUI Desktop first: Generate shot uses it to make the clips.'
  return null
}
