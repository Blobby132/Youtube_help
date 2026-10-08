// The shared media library, as the frontend sees it, plus the imports and Pexels downloads in
// progress. Lives outside components so switching tabs doesn't lose a running download.
import { create } from 'zustand'
import { ApiError, api, type LibraryItem, type StockSource } from '../../lib/api'
import { waitForJob } from '../../lib/jobs'
import { flushSave } from '../../state/project/persistence'
import { updateProject, useProjectStore } from '../../state/project/store'
import { setUi, useUi } from '../../state/ui'
import { looksAiGenerated } from './aiFilename'

/** A file picked or dropped, waiting for you to confirm the AI-generated tick and import it. */
export interface StagedFile {
  key: string
  file: File
  aiGenerated: boolean
}

export interface Transfer {
  progress: number
  message: string
  error: string | null
}

interface LibraryState {
  items: LibraryItem[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  staged: StagedFile[]
  /** Imports running or failed, by staged key. */
  imports: Record<string, Transfer & { name: string }>
  /** Stock downloads running or failed, by downloadKey(source, video id). */
  downloads: Record<string, Transfer>
}

export const useLibrary = create<LibraryState>()(() => ({
  items: [],
  status: 'idle',
  error: null,
  staged: [],
  imports: {},
  downloads: {},
}))

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function upsert(item: LibraryItem) {
  useLibrary.setState((s) => ({ items: [item, ...s.items.filter((i) => i.id !== item.id)] }))
}

export async function loadLibrary() {
  useLibrary.setState({ status: 'loading', error: null })
  try {
    useLibrary.setState({ items: await api.library(), status: 'ready' })
  } catch (error) {
    console.error('Could not load the media library:', error)
    useLibrary.setState({ status: 'error', error: message(error) })
  }
}

// Imports ------------------------------------------------------------------------------------

let stagedCounter = 0

/** Adds picked or dropped files to the import list, pre-ticking ComfyUI outputs as AI-generated. */
export function stageFiles(files: Iterable<File>) {
  const added = [...files].map((file) => ({ key: `f${++stagedCounter}`, file, aiGenerated: looksAiGenerated(file.name) }))
  if (added.length) useLibrary.setState((s) => ({ staged: [...s.staged, ...added] }))
}

export function setStagedAi(key: string, aiGenerated: boolean) {
  useLibrary.setState((s) => ({ staged: s.staged.map((f) => (f.key === key ? { ...f, aiGenerated } : f)) }))
}

export function unstage(key: string) {
  useLibrary.setState((s) => ({ staged: s.staged.filter((f) => f.key !== key) }))
}

function setImport(key: string, value: (Transfer & { name: string }) | null) {
  useLibrary.setState((s) => {
    const imports = { ...s.imports }
    if (value) imports[key] = value
    else delete imports[key]
    return { imports }
  })
}

async function importOne({ key, file, aiGenerated }: StagedFile) {
  setImport(key, { name: file.name, progress: 0, message: `Uploading ${file.name}…`, error: null })
  try {
    const job = await api.importClip(file, aiGenerated)
    const item = await waitForJob(job, (update) =>
      setImport(key, { name: file.name, progress: update.progress, message: update.message, error: null }),
    )
    upsert(item)
    setImport(key, null)
  } catch (error) {
    console.error(`Import of ${file.name} failed:`, error)
    setImport(key, { name: file.name, progress: 0, message: '', error: message(error) })
  }
}

/** Imports every staged file (two at a time) with its AI-generated setting. */
export async function importStaged() {
  const files = useLibrary.getState().staged
  useLibrary.setState({ staged: [] })
  const queue = [...files]
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await importOne(next)
  }
  await Promise.all([worker(), worker()])
}

export const dismissImport = (key: string) => setImport(key, null)

// Stock video (Pexels, Pixabay) -----------------------------------------------------------------

export const downloadKey = (source: StockSource, videoId: number) => `${source}:${videoId}`

function setDownload(key: string, value: Transfer | null) {
  useLibrary.setState((s) => {
    const downloads = { ...s.downloads }
    if (value) downloads[key] = value
    else delete downloads[key]
    return { downloads }
  })
}

/** Downloads a stock video into the library; resolves with the item (null on failure). */
export async function addFromStock(source: StockSource, videoId: number): Promise<LibraryItem | null> {
  const key = downloadKey(source, videoId)
  if (useLibrary.getState().downloads[key]?.error === null) return null // already running
  setDownload(key, { progress: 0, message: 'Starting…', error: null })
  try {
    const job = await api.addFromStock(source, videoId)
    const item = await waitForJob(job, (update) =>
      setDownload(key, { progress: update.progress, message: update.message, error: null }),
    )
    upsert(item)
    setDownload(key, null)
    return item
  } catch (error) {
    console.error(`${source} download ${videoId} failed:`, error)
    setDownload(key, { progress: 0, message: '', error: message(error) })
    return null
  }
}

export const dismissDownload = (source: StockSource, videoId: number) => setDownload(downloadKey(source, videoId), null)

/** Puts items (e.g. from Auto-fill) into the list without reloading it. */
export function addToList(items: LibraryItem[]) {
  for (const item of [...items].reverse()) upsert(item)
}

// Editing -------------------------------------------------------------------------------------

export async function updateItem(itemId: string, changes: { name?: string; aiGenerated?: boolean }) {
  const before = useLibrary.getState().items
  // Show the change straight away; put it back if the backend refuses.
  useLibrary.setState({ items: before.map((i) => (i.id === itemId ? { ...i, ...changes } : i)), error: null })
  try {
    upsertInPlace(await api.updateLibraryItem(itemId, changes))
  } catch (error) {
    useLibrary.setState({ items: before, error: `Could not change the clip: ${message(error)}` })
  }
}

function upsertInPlace(item: LibraryItem) {
  useLibrary.setState((s) => ({ items: s.items.map((i) => (i.id === item.id ? item : i)) }))
}

/** Deletes an item, asking first when a project uses it. Its clips leave gaps in this project. */
export async function deleteItem(itemId: string) {
  const item = useLibrary.getState().items.find((i) => i.id === itemId)
  if (!item) return
  const usedHere = useProjectStore.getState().project.clips.some((c) => c.mediaId === itemId)
  if (usedHere && !window.confirm(`“${item.name}” is on this project's timeline. Delete it from the library and leave a gap there?`)) return
  if (!usedHere && !window.confirm(`Delete “${item.name}” from the library? The file is removed from your PC.`)) return
  await flushSave()
  try {
    try {
      await api.deleteLibraryItem(itemId)
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error
      // Used by other projects too: the backend says which.
      if (!window.confirm(`${error.message} Delete it anyway?`)) return
      await api.deleteLibraryItem(itemId, true)
    }
  } catch (error) {
    useLibrary.setState({ error: `Could not delete “${item.name}”: ${message(error)}` })
    return
  }
  useLibrary.setState((s) => ({ items: s.items.filter((i) => i.id !== itemId) }))
  if (usedHere) {
    updateProject((p) => {
      p.clips = p.clips.filter((c) => c.mediaId !== itemId)
    })
    if (useUi.getState().selectedClipId && !useProjectStore.getState().project.clips.some((c) => c.id === useUi.getState().selectedClipId)) {
      setUi({ selectedClipId: null })
    }
  }
}

export const clearLibraryError = () => useLibrary.setState({ error: null })
