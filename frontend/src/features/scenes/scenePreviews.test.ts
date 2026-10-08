import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type LibraryItem, type ShotJob, type ShotRequest } from '../../lib/api'
import { createProject } from '../../state/project/defaults'
import { useProjectStore } from '../../state/project/store'
import type { ScenePreview } from '../../state/project/types'
import { setUi } from '../../state/ui'
import { useGenerate } from '../generate/generateStore'
import { useLibrary } from '../library/libraryStore'
import { redo, undo, useTimelineHistory } from '../timeline/timelineEdits'
import { selectPreview, updateScene } from './sceneEdits'
import { newScene } from './sceneOps'
import {
  deletePreview,
  generatePreviews,
  GONE_AFTER_MS,
  GONE_MESSAGE,
  previewStatusLine,
  retryPreview,
  syncPreviews,
} from './scenePreviews'

const PROMPT = 'A red fox trots through deep snow at dusk'
let seed = 100
let jobCount = 0
const requests: ShotRequest[] = []

function shotJob(request: ShotRequest, variation: number, patch: Partial<ShotJob> = {}): ShotJob {
  return {
    id: `g-${++jobCount}`,
    batch: 'b-1',
    variation,
    variations: request.variations,
    prompt: request.prompt,
    seed: request.seed ?? ++seed,
    quality: request.quality,
    megapixels: 0.4,
    duration: request.duration,
    fps: 24,
    workflow: 'ltx_t2v_api.json',
    basedOn: null,
    scene: request.scene ?? null,
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
const previews = () => project().scenePreviews
const scenes = () => project().scenes
const jobOf = (preview: ScenePreview) => useGenerate.getState().jobs.find((j) => j.id === preview.jobId)!

/** The backend says this job changed (as the jobs list would after a poll). */
function jobUpdate(jobId: string, patch: Partial<ShotJob>) {
  useGenerate.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, ...patch } : j)), listed: true }))
}

beforeEach(() => {
  vi.useFakeTimers() // the jobs list's polling never runs
  requests.length = 0
  vi.spyOn(api, 'generateShots').mockImplementation(async (request) => {
    requests.push(request)
    return { jobs: Array.from({ length: request.variations }, (_, i) => shotJob(request, i + 1)) }
  })
  vi.spyOn(api, 'listShots').mockImplementation(async () => ({ jobs: useGenerate.getState().jobs }))
  vi.spyOn(api, 'dismissShot').mockImplementation(async (jobId) => ({ deleted: jobId }))
  vi.spyOn(api, 'saveProject').mockImplementation(async (p) => ({ id: p.id, name: p.name, createdAt: null, updatedAt: null }))
  const fresh = createProject()
  fresh.voiceover = { source: 'ai', file: 'v.wav', duration: 12 }
  fresh.scenes = [
    { ...newScene('s1', 0, 3.4), prompt: PROMPT },
    { ...newScene('s2', 3.4, 6), prompt: 'Snow falling on a pine forest', previewCount: 1 },
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

describe('generating previews', () => {
  it('queues the scene’s count of Draft previews, as long as the scene, each with its own seed', async () => {
    await generatePreviews('s1')
    expect(requests).toEqual([
      { prompt: PROMPT, duration: 4, quality: 'draft', variations: 2, scene: { projectId: project().id, sceneId: 's1' } },
    ])
    expect(previews().map((p) => [p.sceneId, p.seed, p.duration, p.status])).toEqual([
      ['s1', 101, 4, 'queued'],
      ['s1', 102, 4, 'queued'],
    ])
    expect(useGenerate.getState().jobs.map((j) => j.id)).toEqual(previews().map((p) => p.jobId))
  })

  it('adds more previews to the ones already there', async () => {
    await generatePreviews('s1')
    const first = previews()
    updateScene('s1', { previewCount: 3 })
    await generatePreviews('s1')
    expect(previews().slice(0, 2)).toEqual(first)
    expect(previews()).toHaveLength(5)
    expect(new Set(previews().map((p) => p.seed)).size).toBe(5)
  })

  it('needs a prompt', async () => {
    updateScene('s1', { prompt: '  ' })
    await expect(generatePreviews('s1')).rejects.toThrow('Write the ComfyUI prompt first')
    expect(requests).toEqual([])
  })
})

describe('following the jobs', () => {
  it('saves each preview’s job state with the project as it changes', async () => {
    await generatePreviews('s1')
    const [a, b] = previews()
    jobUpdate(a.jobId, { status: 'running', progress: 0.62, queuePosition: 0 })
    let synced = syncPreviews(previews(), useGenerate.getState().jobs, [])!
    expect(synced.map((p) => p.status)).toEqual(['running', 'queued'])
    // Progress isn't saved, so it doesn't count as a change.
    jobUpdate(a.jobId, { progress: 0.7 })
    useProjectStore.getState().update((p) => {
      p.scenePreviews = synced
    })
    expect(syncPreviews(previews(), useGenerate.getState().jobs, [])).toBeNull()

    jobUpdate(a.jobId, { status: 'done', itemId: 'm-a', progress: 1 })
    jobUpdate(b.jobId, { status: 'error', error: 'ComfyUI failed in SamplerCustomAdvanced (405:344): CUDA out of memory' })
    synced = syncPreviews(previews(), useGenerate.getState().jobs, [])!
    expect(synced.map((p) => [p.status, p.itemId, p.error])).toEqual([
      ['done', 'm-a', null],
      ['error', null, 'ComfyUI failed in SamplerCustomAdvanced (405:344): CUDA out of memory'],
    ])
  })

  it('finds the clip of a job that is no longer listed, or says it is gone', async () => {
    await generatePreviews('s1')
    const [a, b] = previews()
    const item = { id: 'm-found', generation: { shotId: a.jobId } } as unknown as LibraryItem
    const now = Date.now()
    // Not listed yet (e.g. the list was fetched just before they were made): wait.
    expect(syncPreviews(previews(), [], [item], now)!.map((p) => [p.status, p.itemId])).toEqual([
      ['done', 'm-found'],
      ['queued', null],
    ])
    const later = syncPreviews(previews(), [], [item], now + GONE_AFTER_MS)!
    expect(later.find((p) => p.id === b.id)).toMatchObject({ status: 'error', error: GONE_MESSAGE })
    // Without the library loaded, nothing is decided.
    expect(syncPreviews(previews(), [], null, now + 2 * GONE_AFTER_MS)).toBeNull()
  })

  it('says how far each preview is, from the job’s own progress', async () => {
    await generatePreviews('s1')
    const [a, b] = previews()
    jobUpdate(a.jobId, { status: 'running', progress: 0.62, queuePosition: 0 })
    expect(previewStatusLine(3, 1, 2, a, jobOf(a))).toBe(`Scene 3: preview 1 of 2, seed ${a.seed}, 62%`)
    expect(previewStatusLine(3, 2, 2, b, jobOf(b))).toBe(`Scene 3: preview 2 of 2, seed ${b.seed}, queued (1 ahead)`)
    expect(previewStatusLine(3, 2, 2, { ...b, status: 'error' })).toBe(`Scene 3: preview 2 of 2, seed ${b.seed}, failed`)
  })
})

describe('choosing, retrying and deleting', () => {
  it('Use this picks a preview; the choice can change, and Undo covers it but never removes previews', async () => {
    await generatePreviews('s1')
    const [a, b] = previews()
    selectPreview('s1', a.id)
    selectPreview('s1', b.id)
    expect(scenes()[0].selectedPreviewId).toBe(b.id)
    undo()
    expect(scenes()[0].selectedPreviewId).toBe(a.id)
    undo()
    expect(scenes()[0].selectedPreviewId).toBeNull()
    expect(previews()).toHaveLength(2)
    redo()
    expect(scenes()[0].selectedPreviewId).toBe(a.id)
  })

  it('Retry reruns only the failed preview, with its own seed, and changes nothing else', async () => {
    await generatePreviews('s1')
    await generatePreviews('s2')
    const [failed, ok] = previews()
    jobUpdate(failed.jobId, { status: 'error', error: 'CUDA out of memory' })
    jobUpdate(ok.jobId, { status: 'done', itemId: 'm-ok' })
    useProjectStore.getState().update((p) => {
      p.scenePreviews = syncPreviews(p.scenePreviews, useGenerate.getState().jobs, [])!
    })
    selectPreview('s1', ok.id)
    const before = { scenes: scenes(), previews: previews(), history: useTimelineHistory.getState().past.length }

    await retryPreview(failed.id)
    expect(requests[requests.length - 1]).toEqual({
      prompt: PROMPT,
      duration: 4,
      quality: 'draft',
      variations: 1,
      seed: failed.seed,
      scene: { projectId: project().id, sceneId: 's1' },
    })
    const retried = previews().find((p) => p.id === failed.id)!
    expect(retried).toEqual({ ...before.previews[0], jobId: retried.jobId, status: 'queued', error: null, itemId: null })
    expect(retried.jobId).not.toBe(failed.jobId)
    expect(previews().slice(1)).toEqual(before.previews.slice(1))
    expect(scenes()).toBe(before.scenes)
    expect(useTimelineHistory.getState().past.length).toBe(before.history)
    await vi.waitFor(() => expect(api.dismissShot).toHaveBeenCalledWith(failed.jobId))
  })

  it('Delete removes a preview and its library clip, and clears the choice', async () => {
    await generatePreviews('s1')
    const [a, b] = previews()
    jobUpdate(a.jobId, { status: 'done', itemId: 'm-a' })
    useProjectStore.getState().update((p) => {
      p.scenePreviews = syncPreviews(p.scenePreviews, useGenerate.getState().jobs, [])!
    })
    useLibrary.setState({ items: [{ id: 'm-a', name: 'Fox preview' } as LibraryItem] })
    const deleted = vi.spyOn(api, 'deleteLibraryItem').mockResolvedValue({ deleted: 'm-a', usedIn: [] })
    selectPreview('s1', a.id)

    await deletePreview(b.id) // still queued: cancel it first
    expect(previews()).toHaveLength(2)
    await deletePreview(a.id)
    expect(deleted).toHaveBeenCalledWith('m-a')
    expect(previews().map((p) => p.id)).toEqual([b.id])
    expect(scenes()[0].selectedPreviewId).toBeNull()
  })
})
