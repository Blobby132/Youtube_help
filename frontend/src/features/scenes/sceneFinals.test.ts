import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type FinalRequest, type LibraryItem, type ShotJob, type ShotRequest } from '../../lib/api'
import { createProject } from '../../state/project/defaults'
import { useProjectStore } from '../../state/project/store'
import type { ScenePreview, TimelineClip } from '../../state/project/types'
import { setUi } from '../../state/ui'
import { useGenerate } from '../generate/generateStore'
import { useLibrary } from '../library/libraryStore'
import { newClip } from '../timeline/clipOps'
import { undo, useTimelineHistory } from '../timeline/timelineEdits'
import { selectPreview, updateScene } from './sceneEdits'
import { finalOf, newScene } from './sceneOps'
import { finalSource, generateFinal, OLD_PREVIEW, retryFinal } from './sceneFinals'
import { syncFinals } from './scenePreviews'
import {
  allFinalsBlocker,
  allPreviewsBlocker,
  closeRun,
  generateAllFinals,
  generateAllPreviews,
  generateSceneFinal,
  retryStep,
  runView,
} from './sceneRun'
import { addAllFinalsToTimeline, addFinalToTimeline, finalsToPlace } from './sceneTimeline'

let jobCount = 0
let seed = 100
const shotRequests: ShotRequest[] = []
const finalRequests: FinalRequest[] = []
/** Set to make the next final request fail with this reason. */
let refuse: string | null = null

function job(patch: Partial<ShotJob>): ShotJob {
  return {
    id: `g-${++jobCount}`,
    batch: 'b-1',
    variation: 1,
    variations: 1,
    prompt: 'A fox',
    seed: ++seed,
    quality: 'draft',
    megapixels: 0.8,
    duration: 3,
    fps: 24,
    workflow: 'ltx_t2v_api.json',
    basedOn: null,
    scene: null,
    status: 'queued',
    queuePosition: 1,
    progress: 0,
    message: '',
    itemId: null,
    error: null,
    createdAt: '2026-10-08T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    ...patch,
  }
}

const project = () => useProjectStore.getState().project
const finals = () => project().sceneFinals
const jobsById = () => new Map(useGenerate.getState().jobs.map((j) => [j.id, j]))

function jobUpdate(jobId: string, patch: Partial<ShotJob>) {
  useGenerate.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, ...patch } : j)), listed: true }))
  const synced = syncFinals(finals(), useGenerate.getState().jobs, useLibrary.getState().items)
  if (synced) useProjectStore.getState().update((p) => void (p.sceneFinals = synced))
}

/** A finished preview of a scene, with its clip in the library (with its first pass saved, unless `old`). */
function donePreview(sceneId: string, n: number, old = false): ScenePreview {
  const item = { id: `m-${sceneId}-${n}`, kind: 'video', duration: 3, generation: { type: 'preview', shotId: `g-p${n}` }, latents: old ? null : { video: 'v', audio: 'a' } }
  useLibrary.setState((s) => ({ items: [...s.items, item as unknown as LibraryItem] }))
  const preview: ScenePreview = {
    id: `v-${sceneId}-${n}`,
    sceneId,
    jobId: `g-p-${sceneId}-${n}`,
    seed: 1000 + n,
    prompt: 'A fox',
    duration: 3,
    status: 'done',
    error: null,
    itemId: item.id,
    createdAt: '',
  }
  useProjectStore.getState().update((p) => void p.scenePreviews.push(preview))
  return preview
}

/** The final's job finishes and its clip lands in the library. */
function finishFinal(sceneId: string, duration = 3) {
  const final = finalOf(finals(), sceneId)!
  const itemId = `m-final-${final.id}`
  useLibrary.setState((s) => ({ items: [...s.items, { id: itemId, kind: 'video', duration, generation: { type: 'final', shotId: final.jobId } } as unknown as LibraryItem] }))
  jobUpdate(final.jobId, { status: 'done', itemId, progress: 1 })
  return itemId
}

beforeEach(() => {
  vi.useFakeTimers()
  shotRequests.length = 0
  finalRequests.length = 0
  refuse = null
  vi.spyOn(api, 'generateShots').mockImplementation(async (request) => {
    shotRequests.push(request)
    return { jobs: Array.from({ length: request.variations }, (_, i) => job({ variation: i + 1, variations: request.variations, scene: request.scene, prompt: request.prompt, kind: 'preview' })) }
  })
  vi.spyOn(api, 'generateFinal').mockImplementation(async (request) => {
    if (refuse) throw new Error(refuse)
    finalRequests.push(request)
    return { job: job({ kind: 'final', quality: 'final', scene: request.scene, previewItemId: request.previewItemId, refineSeed: request.seed ?? 42 }) }
  })
  vi.spyOn(api, 'listShots').mockImplementation(async () => ({ jobs: useGenerate.getState().jobs }))
  vi.spyOn(api, 'dismissShot').mockImplementation(async (jobId) => ({ deleted: jobId }))
  vi.spyOn(api, 'saveProject').mockImplementation(async (p) => ({ id: p.id, name: p.name, createdAt: null, updatedAt: null }))
  const fresh = createProject()
  fresh.voiceover = { source: 'ai', file: 'v.wav', duration: 12 }
  fresh.scenes = [
    { ...newScene('s1', 0, 3), prompt: 'A fox in the snow', previewCount: 1 },
    { ...newScene('s2', 3, 5.5), prompt: 'Snow on pines', previewCount: 1 },
    { ...newScene('s3', 5.5, 8), source: 'stock', searchText: 'forest' },
  ]
  useProjectStore.getState().replace(fresh)
  useGenerate.setState({ jobs: [], listed: true, error: null })
  useLibrary.setState({ items: [], status: 'ready' })
  useTimelineHistory.setState({ past: [], future: [], notice: null })
  setUi({ selectedSceneId: null })
  vi.stubGlobal('window', { confirm: () => true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a scene’s final', () => {
  it('Generate final asks for a final from the chosen preview itself, and only that scene changes', async () => {
    const [, chosen] = [donePreview('s1', 1), donePreview('s1', 2)]
    selectPreview('s1', chosen.id)
    const before = { scenes: project().scenes, previews: project().scenePreviews, history: useTimelineHistory.getState().past.length }

    await generateFinal('s1')
    expect(finalRequests).toEqual([{ previewItemId: 'm-s1-2', scene: { projectId: project().id, sceneId: 's1' } }])
    expect(finals()).toEqual([
      { id: expect.stringMatching(/^f-/), sceneId: 's1', previewId: chosen.id, previewItemId: 'm-s1-2', jobId: expect.any(String), refineSeed: 42, status: 'queued', error: null, itemId: null, createdAt: expect.any(String) },
    ])
    expect(project().scenes).toBe(before.scenes)
    expect(project().scenePreviews).toBe(before.previews)
    expect(useTimelineHistory.getState().past.length).toBe(before.history) // not an undo step
    expect(finalOf(finals(), 's2')).toBeUndefined()
  })

  it('Regenerate final makes another from the chosen preview with a new refine seed', async () => {
    selectPreview('s1', donePreview('s1', 1).id)
    await generateFinal('s1')
    const first = finals()[0]
    finishFinal('s1')
    await generateFinal('s1', true)
    expect(finalRequests[1]).toEqual({ previewItemId: 'm-s1-1', scene: { projectId: project().id, sceneId: 's1' }, seed: expect.any(Number) })
    expect(finalRequests[1].seed).not.toBe(42)
    expect(finals()).toHaveLength(2)
    expect(finals()[0]).toMatchObject({ id: first.id, status: 'done' }) // the first stays (and its clip)
    expect(finalOf(finals(), 's1')).toMatchObject({ refineSeed: finalRequests[1].seed, status: 'queued' })
  })

  it('needs a chosen, finished preview with its first pass saved; an old preview says it can’t match', async () => {
    const scene = () => project().scenes[0]
    expect(finalSource(scene(), project().scenePreviews, [])).toEqual({ problem: 'Choose a preview first (Use this): the final is made from it.' })
    const old = donePreview('s1', 1, true)
    selectPreview('s1', old.id)
    expect(finalSource(scene(), project().scenePreviews, useLibrary.getState().items)).toEqual({ problem: OLD_PREVIEW })
    await expect(generateFinal('s1')).rejects.toThrow(OLD_PREVIEW)
    expect(OLD_PREVIEW).toContain('a final made from it would be a different video')
    expect(finalRequests).toEqual([])
    expect(finals()).toEqual([])
  })

  it('Retry reruns only the failed final, from the same preview with the same refine seed', async () => {
    selectPreview('s1', donePreview('s1', 1).id)
    selectPreview('s2', donePreview('s2', 1).id)
    await generateFinal('s1')
    await generateFinal('s2')
    const [failed, other] = finals()
    jobUpdate(failed.jobId, { status: 'error', error: 'ComfyUI failed in SamplerCustomAdvanced (405:368): CUDA out of memory' })
    expect(finals()[0]).toMatchObject({ status: 'error', error: 'ComfyUI failed in SamplerCustomAdvanced (405:368): CUDA out of memory' })

    await retryFinal(failed.id)
    expect(finalRequests[2]).toEqual({ previewItemId: 'm-s1-1', scene: { projectId: project().id, sceneId: 's1' }, seed: 42 })
    expect(finals()[0]).toMatchObject({ id: failed.id, status: 'queued', error: null })
    expect(finals()[0].jobId).not.toBe(failed.jobId)
    expect(finals()[1]).toEqual(other)
    await vi.waitFor(() => expect(api.dismissShot).toHaveBeenCalledWith(failed.jobId))
  })
})

describe('generating for every scene', () => {
  it('Generate all previews makes previews only for AI scenes without any, and chooses none', async () => {
    donePreview('s1', 1)
    updateScene('s2', { prompt: '' })
    project().scenes.forEach((s) => expect(s.selectedPreviewId).toBeNull())
    useProjectStore.getState().update((p) => void p.scenes.push({ ...newScene('s4', 8, 11), prompt: 'Sunrise', previewCount: 2 }))
    expect(allPreviewsBlocker(project())).toBeNull()

    await generateAllPreviews()
    // Scene 1 has previews and scene 3 is stock; scene 2 has no prompt, so only scene 4 is queued.
    expect(shotRequests).toEqual([{ prompt: 'Sunrise', duration: 3, quality: 'draft', variations: 2, scene: { projectId: project().id, sceneId: 's4' } }])
    expect(project().scenes.map((s) => s.selectedPreviewId)).toEqual([null, null, null, null])
    let view = runView(project().generationRun!, project(), jobsById())
    expect(view.steps.map((s) => [s.number, s.kind, s.state, s.text, s.error])).toEqual([
      [2, 'previews', 'error', 'Previews: couldn’t start', 'Write the ComfyUI prompt first: it says what the preview shows.'],
      [4, 'previews', 'queued', 'Previews: 0 of 2 done, queued (1 ahead)', null],
    ])
    expect(view.total).toBe(0)

    // Progress from the jobs: one preview at 50%, the other done (scene 2 still counts, as not done).
    const [a, b] = project().scenePreviews.filter((p) => p.sceneId === 's4')
    useGenerate.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === a.jobId ? { ...j, status: 'running', progress: 0.5 } : j.id === b.jobId ? { ...j, status: 'done', progress: 1 } : j)) }))
    view = runView(project().generationRun!, project(), jobsById())
    expect(view.steps[1].text).toBe('Previews: 1 of 2 done, generating 50%')
    expect(view.total).toBeCloseTo((0 + 0.5 + 1) / 3)

    // Retry for scene 2 only, once it has a prompt.
    updateScene('s2', { prompt: 'Snow on pines' })
    await retryStep('s2', 'previews')
    expect(shotRequests.map((r) => r.scene?.sceneId)).toEqual(['s4', 's2'])
    view = runView(project().generationRun!, project(), jobsById())
    expect(view.steps.map((s) => s.state)).toEqual(['queued', 'running'])
    expect(allPreviewsBlocker(project())).toBe('Every AI scene has previews. Generate previews on a scene adds more.')
  })

  it('Generate all finals waits for a chosen preview in every AI scene, then makes each scene’s final', async () => {
    selectPreview('s1', donePreview('s1', 1).id)
    donePreview('s2', 1)
    expect(allFinalsBlocker(project())).toBe('Choose a preview (Use this) for scene 2 first.')
    await generateAllFinals()
    expect(finalRequests).toEqual([])

    selectPreview('s2', 'v-s2-1')
    expect(allFinalsBlocker(project())).toBeNull()
    await generateAllFinals()
    expect(finalRequests.map((r) => [r.scene.sceneId, r.previewItemId])).toEqual([
      ['s1', 'm-s1-1'],
      ['s2', 'm-s2-1'],
    ])
    const view = runView(project().generationRun!, project(), jobsById())
    expect(view.steps.map((s) => [s.number, s.kind, s.state])).toEqual([
      [1, 'final', 'queued'],
      [2, 'final', 'queued'],
    ])
    expect(allFinalsBlocker(project())).toBe('Every AI scene has its final. Regenerate final on a scene makes it again.')
  })

  it('a failed final shows its error and a Retry for that scene only, and the others keep going', async () => {
    for (const id of ['s1', 's2']) selectPreview(id, donePreview(id, 1).id)
    await generateAllFinals()
    const [first, second] = finals()
    jobUpdate(first.jobId, { status: 'error', error: 'ComfyUI failed in VAEDecodeTiled (405:374): out of memory' })
    jobUpdate(second.jobId, { status: 'running', progress: 0.25, queuePosition: 0 })
    let view = runView(project().generationRun!, project(), jobsById())
    expect(view.steps.map((s) => [s.state, s.text, s.error])).toEqual([
      ['error', 'Final: failed', 'ComfyUI failed in VAEDecodeTiled (405:374): out of memory'],
      ['running', 'Final: generating 25%', null],
    ])
    expect((view.total * 100).toFixed(1)).toBe('12.5')

    await retryStep('s1', 'final')
    expect(finalRequests.slice(2)).toEqual([{ previewItemId: 'm-s1-1', scene: { projectId: project().id, sceneId: 's1' }, seed: 42 }])
    expect(finals()[1]).toMatchObject({ jobId: second.jobId, status: 'running' }) // untouched
    view = runView(project().generationRun!, project(), jobsById())
    expect(view.steps.map((s) => s.state)).toEqual(['queued', 'running'])
  })

  it('a final that can’t be sent (an old preview) is that scene’s error; the rest are sent', async () => {
    selectPreview('s1', donePreview('s1', 1, true).id)
    selectPreview('s2', donePreview('s2', 1).id)
    await generateAllFinals()
    expect(finalRequests.map((r) => r.scene.sceneId)).toEqual(['s2'])
    const view = runView(project().generationRun!, project(), jobsById())
    expect(view.steps.map((s) => [s.state, s.error])).toEqual([
      ['error', OLD_PREVIEW],
      ['queued', null],
    ])
  })

  it('a scene’s own Generate final joins a running run; a finished run makes way for a new one', async () => {
    for (const id of ['s1', 's2']) selectPreview(id, donePreview(id, 1).id)
    refuse = 'ComfyUI isn’t answering'
    await generateAllFinals()
    refuse = null
    const runId = project().generationRun!.id
    expect(runView(project().generationRun!, project(), jobsById()).active).toBe(false)
    // Finished (both failed to start): a new Generate final starts a new run.
    await generateSceneFinal('s1')
    expect(project().generationRun!.id).not.toBe(runId)
    expect(project().generationRun!.steps.map((s) => s.sceneId)).toEqual(['s1'])
    // Running: scene 2's joins it.
    await generateSceneFinal('s2')
    expect(project().generationRun!.steps.map((s) => s.sceneId)).toEqual(['s1', 's2'])
    closeRun()
    expect(project().generationRun).not.toBeNull() // still running
    for (const final of finals()) jobUpdate(final.jobId, { status: 'done', itemId: `m-${final.id}` })
    closeRun()
    expect(project().generationRun).toBeNull()
  })
})

describe('putting finals on the timeline', () => {
  async function madeFinal(sceneId: string, duration = 3) {
    selectPreview(sceneId, donePreview(sceneId, 1).id)
    await generateFinal(sceneId)
    return finishFinal(sceneId, duration)
  }

  const clipOf = (mediaId: string) => project().clips.find((c) => c.mediaId === mediaId)

  it('Add to timeline puts the final over exactly its scene, as one undo step, and never twice', async () => {
    const item = await madeFinal('s2')
    const before = useTimelineHistory.getState().past.length
    expect(addFinalToTimeline('s2')).toBe(true)
    expect(clipOf(item)).toMatchObject({ start: 3, duration: 2.5, inPoint: 0, speed: 1 })
    expect(useTimelineHistory.getState().past.length).toBe(before + 1)
    // The same final again: nothing happens.
    expect(addFinalToTimeline('s2')).toBe(false)
    expect(finalsToPlace(project(), useLibrary.getState().items)).toEqual([])
    expect(project().clips).toHaveLength(1)
    undo()
    expect(project().clips).toEqual([])
  })

  it('asks before replacing clips already in the scene’s time; saying no leaves them', async () => {
    const item = await madeFinal('s1')
    const stock: TimelineClip = newClip('c-stock', 'm-stock', 1, 4) // 1 s to 5 s: across scene 1's end
    useProjectStore.getState().update((p) => void (p.clips = [stock]))
    const questions: string[] = []
    vi.stubGlobal('window', { confirm: (q: string) => (questions.push(q), false) })
    expect(addFinalToTimeline('s1')).toBe(false)
    expect(questions).toEqual(['Scene 1 already has clips between 0:00.00 and 0:03.00. Replace them with its final? Undo (Ctrl+Z) brings them back.'])
    expect(project().clips).toEqual([stock])

    vi.stubGlobal('window', { confirm: () => true })
    expect(addFinalToTimeline('s1')).toBe(true)
    expect(clipOf(item)).toMatchObject({ start: 0, duration: 3 })
    expect(clipOf('m-stock')).toMatchObject({ start: 3, duration: 2, inPoint: 2 }) // only the part outside the scene is left
    undo()
    expect(project().clips).toEqual([stock])
  })

  it('Add all places every finished final in one undo step, replacing or keeping clips as asked', async () => {
    const one = await madeFinal('s1')
    const two = await madeFinal('s2', 2) // shorter than its 2.5 s scene: plays slower to fill it
    const stock = newClip('c-stock', 'm-stock', 0, 2)
    useProjectStore.getState().update((p) => void (p.clips = [stock]))
    expect(finalsToPlace(project(), useLibrary.getState().items).map((p) => [p.sceneId, p.covered])).toEqual([
      ['s1', true],
      ['s2', false],
    ])

    // Only the empty scenes: scene 1 keeps its clip.
    const before = useTimelineHistory.getState().past.length
    expect(addAllFinalsToTimeline(false)).toBe(1)
    expect(clipOf(one)).toBeUndefined()
    expect(clipOf(two)).toMatchObject({ start: 3, duration: 2.5, speed: 0.8 })
    expect(useTimelineHistory.getState().past.length).toBe(before + 1)

    // Now replace: only scene 1's final is left to add (scene 2's is already there).
    expect(addAllFinalsToTimeline(true)).toBe(1)
    expect(clipOf(one)).toMatchObject({ start: 0, duration: 3 })
    expect(clipOf('m-stock')).toBeUndefined()
    expect(project().clips.filter((c) => c.mediaId === two)).toHaveLength(1)
    undo()
    expect(project().clips.map((c) => c.mediaId)).toEqual(['m-stock', two])
  })
})
