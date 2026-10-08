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

  it('keeps "Fit inside" and the canvas settings', () => {
    const saved = createProject()
    saved.clips = [{ id: 'c1', mediaId: 'm1', start: 0, duration: 2, inPoint: 0, speed: 1, cropX: 0.5, cropY: 0.5, fit: 'inside', keepAudio: false, volume: 0.5 }]
    saved.canvas.background = { mode: 'color', color: '#112233', blur: 20 }
    const project = normalizeProject(JSON.parse(JSON.stringify(saved)))
    expect(project.clips[0].fit).toBe('inside')
    expect(project.canvas.background).toEqual({ mode: 'color', color: '#112233', blur: 20 })
  })
})
