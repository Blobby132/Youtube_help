// The app-wide pronunciation list. Edits save themselves shortly after you stop typing.
import { create } from 'zustand'
import { api } from '../../lib/api'
import { newId } from '../../lib/ids'

export interface PronunciationRow {
  id: string
  written: string
  spoken: string
}

interface PronunciationState {
  rows: PronunciationRow[]
  status: 'loading' | 'ready' | 'error'
  save: 'idle' | 'saving' | 'saved' | 'error'
  error: string | null
}

export const usePronunciations = create<PronunciationState>()(() => ({
  rows: [],
  status: 'loading',
  save: 'idle',
  error: null,
}))

const SAVE_DELAY_MS = 600
let loading: Promise<void> | null = null
let loaded = false
let dirty = false
let timer: ReturnType<typeof setTimeout> | undefined
let inFlight: Promise<void> | null = null

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function loadPronunciations(): Promise<void> {
  if (loaded) return Promise.resolve()
  loading ??= api
    .getPronunciations()
    .then(({ entries }) => {
      loaded = true
      usePronunciations.setState({
        rows: entries.map((entry) => ({ id: newId('pr', 8), ...entry })),
        status: 'ready',
        error: null,
      })
    })
    .catch((error: unknown) => {
      usePronunciations.setState({ status: 'error', error: message(error) })
    })
    .finally(() => {
      loading = null
    })
  return loading
}

function setRows(rows: PronunciationRow[]) {
  usePronunciations.setState({ rows })
  dirty = true
  clearTimeout(timer)
  timer = setTimeout(() => void savePronunciations(), SAVE_DELAY_MS)
}

export function addPronunciation() {
  setRows([...usePronunciations.getState().rows, { id: newId('pr', 8), written: '', spoken: '' }])
}

export function editPronunciation(id: string, patch: Partial<Omit<PronunciationRow, 'id'>>) {
  setRows(usePronunciations.getState().rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
}

export function removePronunciation(id: string) {
  setRows(usePronunciations.getState().rows.filter((row) => row.id !== id))
}

/** Saves pending edits now (e.g. before hearing an entry, so the backend uses them). */
export async function savePronunciations(): Promise<void> {
  clearTimeout(timer)
  if (inFlight) await inFlight
  if (!dirty) return
  dirty = false
  const entries = usePronunciations.getState().rows.map(({ written, spoken }) => ({ written, spoken }))
  usePronunciations.setState({ save: 'saving' })
  inFlight = api
    .savePronunciations(entries)
    .then(() => usePronunciations.setState({ save: dirty ? 'saving' : 'saved', error: null }))
    .catch((error: unknown) => {
      dirty = true
      usePronunciations.setState({ save: 'error', error: message(error) })
    })
    .finally(() => {
      inFlight = null
    })
  await inFlight
}
