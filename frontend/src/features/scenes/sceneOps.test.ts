import { describe, expect, it } from 'vitest'
import type { Scene } from '../../state/project/types'
import {
  addScene,
  deleteScene,
  mergeWithNext,
  newScene,
  normalizePreviews,
  normalizeScenes,
  orphanPreviews,
  previewSeconds,
  resizeScene,
  setSceneEdge,
  splitPoint,
  splitScene,
} from './sceneOps'

const scene = (id: string, start: number, end: number, patch: Partial<Scene> = {}): Scene => ({ ...newScene(id, start, end), ...patch })
const times = (scenes: Scene[]) => scenes.map((s) => [s.id, s.start, s.end])

// Three touching scenes, then a gap, then one more.
const SCENES = [scene('a', 0, 3), scene('b', 3, 6), scene('c', 6, 8), scene('d', 10, 12)]

describe('resizeScene (dragging an edge)', () => {
  it('moves the edge it shares with the next scene along with it', () => {
    expect(times(resizeScene(SCENES, 'a', 'end', 4))).toEqual([
      ['a', 0, 4],
      ['b', 4, 6],
      ['c', 6, 8],
      ['d', 10, 12],
    ])
    expect(times(resizeScene(SCENES, 'b', 'start', 2.5)).slice(0, 2)).toEqual([
      ['a', 0, 2.5],
      ['b', 2.5, 6],
    ])
  })

  it('keeps both scenes at least 0.5 s long', () => {
    expect(times(resizeScene(SCENES, 'a', 'end', 9)).slice(0, 2)).toEqual([
      ['a', 0, 5.5],
      ['b', 5.5, 6],
    ])
    expect(times(resizeScene(SCENES, 'b', 'end', 3.1))[1]).toEqual(['b', 3, 3.5])
  })

  it('stops at a scene it does not touch, at 0, and at a detached neighbour', () => {
    expect(times(resizeScene(SCENES, 'c', 'end', 11))[2]).toEqual(['c', 6, 10])
    expect(times(resizeScene(SCENES, 'd', 'start', 1))[3]).toEqual(['d', 8, 12])
    expect(times(resizeScene(SCENES, 'a', 'start', -2))[0]).toEqual(['a', 0, 3])
    // Shift-drag: only this scene's edge moves, and it can't go into the neighbour.
    expect(times(resizeScene(SCENES, 'a', 'end', 2, true)).slice(0, 2)).toEqual([
      ['a', 0, 2],
      ['b', 3, 6],
    ])
    expect(times(resizeScene(SCENES, 'a', 'end', 4, true))[0]).toEqual(['a', 0, 3])
  })
})

describe('setSceneEdge (typed times)', () => {
  it('sets a time, moving a touching neighbour along', () => {
    const result = setSceneEdge(SCENES, 'b', 'end', 6.5)
    expect('scenes' in result && times(result.scenes).slice(1, 3)).toEqual([
      ['b', 3, 6.5],
      ['c', 6.5, 8],
    ])
    const gap = setSceneEdge(SCENES, 'c', 'end', 9.25)
    expect('scenes' in gap && times(gap.scenes)[2]).toEqual(['c', 6, 9.25])
  })

  it('explains a time it can’t use, and changes nothing', () => {
    expect(setSceneEdge(SCENES, 'b', 'start', 6)).toEqual({
      error: 'The start has to be before the end (0:06.00). To move the scene later, change its end first.',
    })
    expect(setSceneEdge(SCENES, 'b', 'end', 3.3)).toEqual({ error: 'A scene has to be at least 0.5 s long.' })
    expect(setSceneEdge(SCENES, 'b', 'end', 7.8)).toEqual({
      error: 'That leaves scene 3 (0:06.00–0:08.00) shorter than 0.5 s. Change or delete that scene first.',
    })
    expect(setSceneEdge(SCENES, 'c', 'end', 10.5)).toEqual({ error: 'That overlaps scene 4 (0:10.00–0:12.00). Scenes can’t overlap.' })
    expect(setSceneEdge(SCENES, 'd', 'start', 2)).toEqual({ error: 'That overlaps scene 1 (0:00.00–0:03.00). Scenes can’t overlap.' })
  })
})

describe('split, merge, add and delete', () => {
  it('splits at the playhead, else at the word boundary nearest the middle', () => {
    const b = SCENES[1]
    expect(splitPoint(b, 4.2, [])).toBe(4.2)
    expect(splitPoint(b, 3.2, [3.1, 4.3, 4.8, 5.9])).toBe(4.3) // the playhead is too close to the start
    expect(splitPoint(b, 0, [])).toBe(4.5)
    expect(splitPoint(scene('x', 0, 0.8), 0.4, [])).toBeNull()
  })

  it('split keeps the scene in the first part and copies its texts to the second', () => {
    const texts = { prompt: 'A lighthouse at dusk', description: 'Lighthouse', searchText: 'lighthouse', source: 'stock' as const }
    const scenes = [scene('a', 0, 4, { ...texts, selectedPreviewId: 'v1', stockItemId: 'm1' })]
    const split = splitScene(scenes, 'a', 1.5, 'a2')!
    expect(split).toEqual([
      { ...scenes[0], end: 1.5 },
      { ...scenes[0], id: 'a2', start: 1.5, selectedPreviewId: null, stockItemId: null },
    ])
    expect(splitScene(scenes, 'a', 0.2, 'a2')).toBeNull()
  })

  it('merge joins a scene with the next one and keeps the first', () => {
    const scenes = [scene('a', 0, 3, { prompt: 'Fox', selectedPreviewId: 'v1' }), scene('b', 3, 6, { prompt: 'Snow', description: 'Snowfield' })]
    expect(mergeWithNext(scenes, 'a')).toEqual([{ ...scenes[0], end: 6, description: 'Snowfield' }])
    expect(mergeWithNext(scenes, 'b')).toBeNull()
    // Across a gap, the merged scene covers it.
    expect(times(mergeWithNext(SCENES, 'c')!)).toEqual([
      ['a', 0, 3],
      ['b', 3, 6],
      ['c', 6, 12],
    ])
  })

  it('adds a scene at the playhead, else in the first free time, within the video', () => {
    expect(times(addScene(SCENES, 8.5, 12, 'n')!)[3]).toEqual(['n', 8.5, 10])
    expect(times(addScene(SCENES, 1, 12, 'n')!)[3]).toEqual(['n', 8, 10])
    expect(addScene(SCENES.slice(0, 3), 1, 8, 'n')).toBeNull() // no free time
    expect(times(addScene([], 2, 0, 'n')!)).toEqual([['n', 2, 5]]) // no video length yet
    expect(times(addScene([], 7, 8, 'n')!)).toEqual([['n', 7, 8]])
  })

  it('deletes a scene', () => {
    expect(deleteScene(SCENES, 'b').map((s) => s.id)).toEqual(['a', 'c', 'd'])
  })
})

describe('previews', () => {
  it('are as long as their scene, rounded up to whole seconds, 2 to 5', () => {
    expect([1.2, 2, 3, 3.01, 4.99, 5, 7.5].map((length) => previewSeconds({ start: 1, end: 1 + length }))).toEqual([2, 2, 3, 4, 5, 5, 5])
  })

  it('whose scene is gone are listed apart', () => {
    const preview = (id: string, sceneId: string) => ({
      id,
      sceneId,
      jobId: `g-${id}`,
      seed: 1,
      prompt: '',
      duration: 3,
      status: 'done' as const,
      error: null,
      itemId: null,
      createdAt: '',
    })
    expect(orphanPreviews([preview('v1', 'a'), preview('v2', 'gone')], SCENES).map((p) => p.id)).toEqual(['v2'])
  })
})

describe('loading saved scenes', () => {
  it('fills in missing fields, sorts, and drops broken or overlapping scenes', () => {
    const scenes = normalizeScenes([
      { id: 'b', start: 3, end: 6, source: 'stock', searchText: 'ocean', previewCount: 9 },
      { id: 'a', start: 0, end: 3.5, prompt: 'Fox', selectedPreviewId: 'v1' },
      { id: 'c', start: 5.8, end: 6.1 }, // inside b: too little left after it
      { id: 'd', start: 'soon', end: 9 },
      { id: 'e', start: 9, end: 8 },
      'nonsense',
    ])
    expect(scenes).toEqual([
      { ...newScene('a', 0, 3.5), prompt: 'Fox', selectedPreviewId: 'v1' },
      { ...newScene('b', 3.5, 6), source: 'stock', searchText: 'ocean', previewCount: 4 },
    ])
    expect(normalizeScenes(undefined)).toEqual([])
  })

  it('keeps previews with their job state, and drops ones without a job or seed', () => {
    const saved = { id: 'v1', sceneId: 'a', jobId: 'g-1', seed: 77, prompt: 'Fox', duration: 3, status: 'running', error: null, itemId: null, createdAt: 'x' }
    expect(
      normalizePreviews([saved, { ...saved, id: 'v2', jobId: undefined }, { ...saved, id: 'v3', seed: 'x' }, { ...saved, id: 'v4', status: 'weird' }]),
    ).toEqual([saved, { ...saved, id: 'v4', status: 'error' }])
  })
})
