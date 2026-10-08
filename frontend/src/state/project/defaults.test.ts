import { describe, expect, it } from 'vitest'
import { createProject, normalizeProject } from './defaults'

describe('normalizeProject', () => {
  it('gives projects saved before Stage 5 filled clips and the ranking style', () => {
    const old = {
      id: 'p-old',
      name: 'Old',
      clips: [{ id: 'c1', mediaId: 'm1', start: 0, duration: 2, inPoint: 0, speed: 1, cropX: 0.3, cropY: 0.5, keepAudio: false, volume: 0.5 }],
      ranking: { enabled: true, direction: 'up', entries: [{ id: 'r1', label: 'First', clipId: 'c1' }] },
    }
    const project = normalizeProject(old)
    expect(project.clips[0]).toMatchObject({ fit: 'fill', cropX: 0.3 })
    expect(project.ranking).toEqual({
      enabled: true,
      direction: 'up',
      entries: [{ id: 'r1', label: 'First', time: { start: 0, end: 2 } }],
      style: createProject().ranking.style,
    })
    expect(project.version).toBe(2)
  })

  it('turns Stage 5 clip links into time ranges', () => {
    const clip = (id: string, start: number, duration: number) => ({ id, mediaId: `m-${id}`, start, duration })
    const stage5 = {
      id: 'p-stage5',
      version: 1,
      clips: [clip('c2', 3, 2.5), clip('c1', 0, 3)],
      ranking: {
        enabled: true,
        direction: 'down',
        entries: [
          { id: 'r1', label: 'First', clipId: 'c1' },
          { id: 'r2', label: 'Second', clipId: 'c2' },
          { id: 'r3', label: 'Unlinked', clipId: null },
          { id: 'r4', label: 'Deleted clip', clipId: 'gone' },
        ],
        style: createProject().ranking.style,
      },
    }
    const project = normalizeProject(stage5)
    expect(project.ranking.entries).toEqual([
      { id: 'r1', label: 'First', time: { start: 0, end: 3 } },
      { id: 'r2', label: 'Second', time: { start: 3, end: 5.5 } },
      { id: 'r3', label: 'Unlinked', time: null },
      { id: 'r4', label: 'Deleted clip', time: null },
    ])
    expect(project.ranking.entries.some((e) => 'clipId' in e)).toBe(false)
  })

  it('keeps saved time ranges, and drops broken ones', () => {
    const saved = createProject()
    saved.ranking.entries = [
      { id: 'r1', label: 'A', time: { start: 1.25, end: 4 } },
      { id: 'r2', label: 'B', time: null },
    ]
    const raw = JSON.parse(JSON.stringify(saved))
    raw.ranking.entries.push({ id: 'r3', label: 'C', time: { start: 5, end: 'later' } })
    expect(normalizeProject(raw).ranking.entries).toEqual([
      { id: 'r1', label: 'A', time: { start: 1.25, end: 4 } },
      { id: 'r2', label: 'B', time: null },
      { id: 'r3', label: 'C', time: null },
    ])
  })

  it('opens projects saved before scenes with no scenes, and keeps the version', () => {
    for (const old of [
      { id: 'p-v1', version: 1, name: 'Stage 5', clips: [], ranking: { entries: [{ id: 'r1', label: 'A', clipId: null }] } },
      { id: 'p-v2', version: 2, name: 'Ranking times', script: 'Hello there.', clips: [] },
    ]) {
      const project = normalizeProject(old)
      expect(project.scenes).toEqual([])
      expect(project.scenePreviews).toEqual([])
      expect(project.version).toBe(2)
    }
  })

  it('keeps scenes, their texts, preview seeds, the selection and job state through a save', () => {
    const saved = createProject()
    saved.scenes = [
      {
        id: 's1',
        start: 0,
        end: 3.2,
        source: 'ai',
        description: 'A fox in the snow',
        prompt: 'A red fox trots through deep snow at dusk',
        searchText: '',
        previewCount: 3,
        selectedPreviewId: 'v2',
        stockItemId: null,
      },
      { id: 's2', start: 3.2, end: 6, source: 'stock', description: '', prompt: '', searchText: 'snowy forest', previewCount: 2, selectedPreviewId: null, stockItemId: 'm-pixabay1' },
    ]
    saved.scenePreviews = [
      { id: 'v1', sceneId: 's1', jobId: 'g-1', seed: 123456, prompt: 'A red fox', duration: 4, status: 'error', error: 'CUDA out of memory', itemId: null, createdAt: '2026-10-08T00:00:00Z' },
      { id: 'v2', sceneId: 's1', jobId: 'g-2', seed: 654321, prompt: 'A red fox', duration: 4, status: 'done', error: null, itemId: 'm-g2', createdAt: '2026-10-08T00:00:00Z' },
      { id: 'v3', sceneId: 's1', jobId: 'g-3', seed: 42, prompt: 'A red fox', duration: 4, status: 'running', error: null, itemId: null, createdAt: '2026-10-08T00:00:00Z' },
    ]
    const reopened = normalizeProject(JSON.parse(JSON.stringify(saved)))
    expect(reopened.scenes).toEqual(saved.scenes)
    expect(reopened.scenePreviews).toEqual(saved.scenePreviews)
    // Media stays in the library: the project only refers to it by id.
    expect(JSON.stringify(reopened)).not.toMatch(/\.mp4|\.webm|data:/)
  })

  it('keeps "Fit inside" and the canvas settings', () => {
    const saved = createProject()
    saved.clips = [{ id: 'c1', mediaId: 'm1', start: 0, duration: 2, inPoint: 0, speed: 1, cropX: 0.5, cropY: 0.5, fit: 'inside', keepAudio: false, volume: 0.5 }]
    saved.canvas.background = { mode: 'color', color: '#112233', blur: 20 }
    const project = normalizeProject(JSON.parse(JSON.stringify(saved)))
    expect(project.clips[0].fit).toBe('inside')
    expect(project.canvas.background).toEqual({ mode: 'color', color: '#112233', blur: 20 })
  })
})
