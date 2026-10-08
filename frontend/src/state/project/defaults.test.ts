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
      entries: [{ id: 'r1', label: 'First', clipId: 'c1' }],
      style: createProject().ranking.style,
    })
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
