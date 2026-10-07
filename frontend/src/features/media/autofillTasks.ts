// Runs Auto-fill: the backend finds and downloads a clip per sentence, then the clips are
// laid on the timeline at their sentences' times. Undo brings the previous clips back.
import { create } from 'zustand'
import { api } from '../../lib/api'
import { newId } from '../../lib/ids'
import { waitForJob } from '../../lib/jobs'
import { useProjectStore } from '../../state/project/store'
import { addToList, useLibrary } from '../library/libraryStore'
import { fitToVoiceover, newClip } from '../timeline/clipOps'
import { editClips, showNotice, sourceLengths } from '../timeline/timelineEdits'
import { planSegments } from './autofillPlan'
import { markInLibrary } from './pexelsStore'

interface AutofillState {
  task: { progress: number; message: string } | null
  error: string | null
  /** What the last run did, e.g. "Placed 5 clips." */
  summary: string | null
  /** Sentences that got no clip, with the reason. */
  misses: { text: string; reason: string }[]
}

export const useAutofill = create<AutofillState>()(() => ({ task: null, error: null, summary: null, misses: [] }))

export async function runAutofill() {
  const project = useProjectStore.getState().project
  const segments = planSegments(project)
  if (!segments.length || useAutofill.getState().task) return
  if (project.clips.length && !window.confirm('Replace the clips on the timeline with auto-filled ones? Undo (Ctrl+Z) brings them back.')) return

  useAutofill.setState({ task: { progress: 0, message: 'Starting…' }, error: null, summary: null, misses: [] })
  try {
    const job = await api.startAutofill(segments.map((s) => s.text))
    const result = await waitForJob(job, (update) => useAutofill.setState({ task: { progress: update.progress, message: update.message } }))
    const items = result.sentences.flatMap((s) => (s.item ? [s.item] : []))
    addToList(items)
    for (const item of items) if (item.pexels) markInLibrary(item.pexels.videoId, item.id)
    if (useProjectStore.getState().project.id !== project.id) {
      useAutofill.setState({ task: null, summary: 'The clips are in the library; another project was opened, so the timeline was left alone.' })
      return
    }

    const clips = result.sentences.flatMap((sentence, index) => {
      const segment = segments[index]
      return sentence.item ? [newClip(newId('c'), sentence.item.id, segment.start, segment.end - segment.start)] : []
    })
    const end = segments[segments.length - 1].end
    // Sentences without a clip are covered by the clip before them; short clips play slower.
    const fitted = fitToVoiceover(clips, end, sourceLengths(useLibrary.getState().items))
    if (clips.length) editClips(() => fitted.clips)
    const misses = result.sentences.flatMap((s) => (s.item ? [] : [{ text: s.text, reason: s.error ?? 'No clip found' }]))
    const placed = `Placed ${clips.length} ${clips.length === 1 ? 'clip' : 'clips'} for ${segments.length} ${segments.length === 1 ? 'sentence' : 'sentences'}.`
    const slowed = fitted.slowed ? ` ${fitted.slowed} short ${fitted.slowed === 1 ? 'clip plays' : 'clips play'} slower to fill ${fitted.slowed === 1 ? 'its' : 'their'} sentence.` : ''
    useAutofill.setState({ task: null, summary: placed + slowed, misses })
    if (clips.length) showNotice(`Auto-fill: ${placed}`)
  } catch (error) {
    console.error('Auto-fill failed:', error)
    useAutofill.setState({ task: null, error: error instanceof Error ? error.message : String(error) })
  }
}
