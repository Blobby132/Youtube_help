// Generating captions runs as a backend job; its progress lives here so switching tabs
// mid-job doesn't lose the result.
import { create } from 'zustand'
import { api } from '../../lib/api'
import { newId } from '../../lib/ids'
import { waitForJob } from '../../lib/jobs'
import { updateProject, useProjectStore } from '../../state/project/store'
import { setUi } from '../../state/ui'

interface CaptionTaskState {
  task: { progress: number; message: string } | null
  error: string | null
  /** Share of script letters Whisper heard, from the last run in this session. */
  matched: number | null
}

export const useCaptionTasks = create<CaptionTaskState>()(() => ({ task: null, error: null, matched: null }))

export async function generateCaptions() {
  const { id: projectId, voiceover, script, captions } = useProjectStore.getState().project
  if (!voiceover || useCaptionTasks.getState().task) return
  if (captions.words.length && !window.confirm('Replace the current captions? Edits you made to them will be lost.')) return

  useCaptionTasks.setState({ task: { progress: 0, message: 'Starting…' }, error: null })
  try {
    const job = await api.startCaptions(projectId, {
      file: voiceover.file,
      // An AI read follows the text it was made from; a recording follows the script box.
      script: voiceover.script ?? (script.trim() || null),
    })
    const result = await waitForJob(job, (update) =>
      useCaptionTasks.setState({ task: { progress: update.progress, message: update.message } }),
    )
    if (useProjectStore.getState().project.id === projectId) {
      updateProject((p) => {
        p.captions.words = result.words.map((word) => ({ id: newId('w', 8), ...word }))
        p.captions.voiceoverFile = result.voiceoverFile
        p.captions.source = result.source
        p.captions.enabled = true
      })
    }
    useCaptionTasks.setState({ task: null, matched: result.matched })
    api.health().then((health) => setUi({ health }), () => undefined)
  } catch (error) {
    console.error('Captions failed:', error)
    useCaptionTasks.setState({ task: null, error: error instanceof Error ? error.message : String(error) })
  }
}
