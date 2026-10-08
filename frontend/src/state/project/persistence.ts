// Loads the last project on startup, autosaves every change to the backend, and
// implements New / Open. Saves are debounced and never overlap.
import { ApiError, api } from '../../lib/api'
import { setUi, useUi } from '../ui'
import { createProject, normalizeProject } from './defaults'
import { useProjectStore } from './store'
import type { Project } from './types'

const AUTOSAVE_DELAY_MS = 800
const RECONNECT_DELAY_MS = 1500
const LAST_PROJECT_KEY = 'shorts-creator.lastProjectId'

let started = false
let savedProject: Project | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined
let inFlight: Promise<void> | null = null
let reconnecting: Promise<void> | null = null

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function rememberProject(id: string) {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id)
  } catch {
    // Storage can be unavailable (private mode); we just open the newest project next time.
  }
}

function lastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY)
  } catch {
    return null
  }
}

/** Polls /api/health until the backend answers. */
export function waitForBackend(): Promise<void> {
  reconnecting ??= (async () => {
    const startedAt = Date.now()
    for (;;) {
      try {
        const health = await api.health()
        setUi({ backend: 'online', health })
        return
      } catch {
        // Give a freshly started backend a few seconds before calling it offline.
        setUi({ backend: Date.now() - startedAt < 8000 && !useUi.getState().health ? 'connecting' : 'offline' })
        await sleep(RECONNECT_DELAY_MS)
      }
    }
  })().finally(() => {
    reconnecting = null
  })
  return reconnecting
}

function isConnectionError(error: unknown) {
  return error instanceof ApiError && (error.status === 0 || error.status >= 502)
}

async function loadInitialProject(): Promise<Project | null> {
  const candidates: string[] = []
  const last = lastProjectId()
  if (last) candidates.push(last)
  const list = await api.listProjects()
  for (const summary of list) if (!candidates.includes(summary.id)) candidates.push(summary.id)

  for (const id of candidates) {
    try {
      return normalizeProject(await api.getProject(id))
    } catch (error) {
      console.warn(`Could not open project ${id}:`, error)
    }
  }
  return null
}

async function saveNow(): Promise<void> {
  clearTimeout(saveTimer)
  if (inFlight) await inFlight

  const { project, loaded } = useProjectStore.getState()
  if (!loaded || project === savedProject) return

  setUi({ save: 'saving' })
  inFlight = api
    .saveProject(project)
    .then(() => {
      savedProject = project
      const latest = useProjectStore.getState().project
      setUi({ save: latest === project ? 'saved' : 'unsaved', saveError: null })
      if (latest !== project) scheduleSave()
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Autosave failed:', error)
      setUi({ save: 'error', saveError: message })
      if (isConnectionError(error)) {
        setUi({ backend: 'offline' })
        void waitForBackend().then(() => scheduleSave(0))
      }
    })
    .finally(() => {
      inFlight = null
    })
  await inFlight
}

function scheduleSave(delay = AUTOSAVE_DELAY_MS) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveNow(), delay)
}

/** Saves any pending change immediately (e.g. before switching projects). */
export const flushSave = saveNow

function resetEditorState() {
  setUi({ playhead: 0, playing: false, selectedClipId: null, selectedSceneId: null })
}

export async function newProject(): Promise<void> {
  await flushSave()
  const project = createProject()
  useProjectStore.getState().replace(project)
  rememberProject(project.id)
  resetEditorState()
  await flushSave()
}

export async function openProject(id: string): Promise<void> {
  await flushSave()
  const project = normalizeProject(await api.getProject(id))
  savedProject = project
  useProjectStore.getState().replace(project)
  rememberProject(project.id)
  resetEditorState()
  setUi({ save: 'saved', saveError: null })
}

/** Connects to the backend, opens the last project and turns on autosave. Runs once. */
export async function startPersistence(): Promise<void> {
  if (started) return
  started = true

  useProjectStore.subscribe((state, previous) => {
    if (!state.loaded || state.project === previous.project || state.project === savedProject) return
    setUi({ save: 'unsaved' })
    scheduleSave()
  })

  window.addEventListener('pagehide', () => {
    const { project, loaded } = useProjectStore.getState()
    if (loaded && project !== savedProject) {
      void api.saveProject(project, { keepalive: true }).catch(() => undefined)
    }
  })

  for (;;) {
    await waitForBackend()
    try {
      const project = await loadInitialProject()
      if (project) {
        savedProject = project
        useProjectStore.getState().replace(project)
        rememberProject(project.id)
        setUi({ save: 'saved' })
      } else {
        await newProject()
      }
      return
    } catch (error) {
      console.error('Could not load projects:', error)
      if (!isConnectionError(error)) {
        setUi({ loadError: error instanceof Error ? error.message : String(error) })
        return
      }
    }
  }
}
