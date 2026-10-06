// Voiceover actions (AI read, recording/upload import, remove). Their progress lives in a
// store rather than a component, so switching tabs mid-generation doesn't lose the result.
import { create } from 'zustand'
import { api } from '../../lib/api'
import { waitForJob } from '../../lib/jobs'
import { updateProject, useProjectStore } from '../../state/project/store'
import type { Voiceover } from '../../state/project/types'
import { setUi } from '../../state/ui'
import { playback } from '../preview/playback'

export type VoiceoverTaskKind = 'ai' | 'recording' | 'upload'

interface VoiceoverTaskState {
  task: { kind: VoiceoverTaskKind; progress: number; message: string } | null
  error: { kind: VoiceoverTaskKind; message: string } | null
}

export const useVoiceoverTasks = create<VoiceoverTaskState>()(() => ({ task: null, error: null }))

const setTask = (kind: VoiceoverTaskKind, progress: number, message: string) =>
  useVoiceoverTasks.setState({ task: { kind, progress, message }, error: null })

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Asks before throwing away a take that can't be regenerated (AI reads can be). */
export function confirmDiscard(action: 'Replace' | 'Remove' = 'Replace'): boolean {
  const current = useProjectStore.getState().project.voiceover
  if (!current || current.source === 'ai') return true
  const what = current.source === 'recording' ? 'your recording' : `the uploaded file (${current.name ?? 'voiceover'})`
  return window.confirm(`${action} ${what}? It can't be brought back.`)
}

function applyVoiceover(projectId: string, voiceover: Voiceover) {
  // The user may have opened another project while this was running.
  if (useProjectStore.getState().project.id !== projectId) return
  playback.pause()
  updateProject((p) => {
    p.voiceover = voiceover
  })
}

async function runTask(kind: VoiceoverTaskKind, work: (projectId: string) => Promise<Voiceover>) {
  if (useVoiceoverTasks.getState().task) {
    useVoiceoverTasks.setState({ error: { kind, message: 'Another voiceover is still being made. Try again when it finishes.' } })
    return
  }
  const projectId = useProjectStore.getState().project.id
  try {
    applyVoiceover(projectId, await work(projectId))
    useVoiceoverTasks.setState({ task: null })
  } catch (error) {
    console.error(`Voiceover (${kind}) failed:`, error)
    useVoiceoverTasks.setState({ task: null, error: { kind, message: errorMessage(error) } })
  }
}

export function generateAiRead() {
  const { script, voiceId, voiceSpeed } = useProjectStore.getState().project
  if (!script.trim() || !confirmDiscard()) return
  return runTask('ai', async (projectId) => {
    setTask('ai', 0, 'Starting…')
    const job = await api.startAiRead(projectId, { text: script, voiceId, speed: voiceSpeed })
    const voiceover = await waitForJob(job, (update) => setTask('ai', update.progress, update.message))
    // The model may have just been downloaded and loaded: refresh what the UI shows about it.
    api.health().then((health) => setUi({ health }), () => undefined)
    return voiceover
  })
}

/** Imports a microphone recording or an uploaded file as the voiceover (confirm first). */
export function importVoiceover(file: Blob, fileName: string, source: 'recording' | 'upload') {
  return runTask(source, async (projectId) => {
    setTask(source, 0, source === 'recording' ? 'Processing your recording…' : `Uploading ${fileName}…`)
    return api.uploadVoiceover(projectId, file, fileName, source)
  })
}

export function removeVoiceover() {
  if (!confirmDiscard('Remove')) return
  playback.pause()
  updateProject((p) => {
    p.voiceover = null
  })
}

export function clearVoiceoverError() {
  useVoiceoverTasks.setState({ error: null })
}
