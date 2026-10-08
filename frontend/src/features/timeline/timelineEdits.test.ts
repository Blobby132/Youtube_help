import { beforeEach, describe, expect, it } from 'vitest'
import type { LibraryItem } from '../../lib/api'
import { createProject } from '../../state/project/defaults'
import { updateProject, useProjectStore } from '../../state/project/store'
import { setUi, useUi } from '../../state/ui'
import { useLibrary } from '../library/libraryStore'
import { addToTimeline, deleteSelected, fitClips, redo, splitAtPlayhead, undo, updateClip, useTimelineHistory } from './timelineEdits'

const item = (id: string, duration: number | null, aiGenerated = false): LibraryItem => ({
  id,
  kind: duration === null ? 'image' : 'video',
  name: id,
  file: `${id}.mp4`,
  thumbnail: null,
  width: 1080,
  height: 1920,
  duration,
  fps: 30,
  hasAudio: true,
  size: 1,
  source: 'upload',
  aiGenerated,
  lowRes: false,
  originalName: null,
  addedAt: '',
  pexels: null,
  pixabay: null,
  generation: null,
})

const clips = () => useProjectStore.getState().project.clips
const spans = () => clips().map((c) => `${c.mediaId}@${c.start}-${+(c.start + c.duration).toFixed(3)}`)

beforeEach(() => {
  const project = createProject()
  project.voiceover = { source: 'ai', file: 'v.wav', duration: 10 }
  useProjectStore.getState().replace(project)
  useLibrary.setState({ items: [item('m-a', 3), item('m-b', 6, true), item('m-img', null)], status: 'ready' })
  useTimelineHistory.setState({ past: [], future: [], notice: null })
  setUi({ selectedClipId: null, playhead: 0 })
})

describe('timeline edits', () => {
  it('adds library items into the first gap and selects them', () => {
    addToTimeline(item('m-a', 3))
    addToTimeline(item('m-b', 6, true))
    expect(spans()).toEqual(['m-a@0-3', 'm-b@3-9'])
    expect(useUi.getState().selectedClipId).toBe(clips()[1].id)
  })

  it('undoes and redoes, one step per edit', () => {
    addToTimeline(item('m-a', 3))
    addToTimeline(item('m-img', null), 5)
    expect(spans()).toEqual(['m-a@0-3', 'm-img@5-10'])
    undo()
    expect(spans()).toEqual(['m-a@0-3'])
    undo()
    expect(spans()).toEqual([])
    redo()
    redo()
    expect(spans()).toEqual(['m-a@0-3', 'm-img@5-10'])
    expect(useTimelineHistory.getState().future).toEqual([])
  })

  it('a slider drag undoes as one step', () => {
    const id = addToTimeline(item('m-a', 3))
    for (const x of [0.4, 0.3, 0.2, 0.1]) updateClip(id, { cropX: x }, 'crop')
    expect(clips()[0].cropX).toBe(0.1)
    undo()
    expect(clips()[0].cropX).toBe(0.5)
  })

  it('splits at the playhead and deletes the selected clip', () => {
    addToTimeline(item('m-b', 6, true))
    setUi({ playhead: 2, selectedClipId: null })
    expect(splitAtPlayhead()).toBe(true)
    expect(spans()).toEqual(['m-b@0-2', 'm-b@2-6'])
    setUi({ selectedClipId: clips()[1].id })
    deleteSelected()
    expect(spans()).toEqual(['m-b@0-2'])
    expect(useUi.getState().selectedClipId).toBeNull()
    setUi({ playhead: 8 })
    expect(splitAtPlayhead()).toBe(false)
    expect(useTimelineHistory.getState().notice).toMatch(/over a clip/)
  })

  it('fits to the voiceover and explains slowed clips', () => {
    addToTimeline(item('m-a', 3))
    addToTimeline(item('m-b', 6, true), 6)
    fitClips()
    expect(spans()).toEqual(['m-a@0-6', 'm-b@6-10'])
    expect(clips()[0].speed).toBe(0.5)
    expect(useTimelineHistory.getState().notice).toBe('Slowed 1 clip down to fill its stretch.')
  })

  it('leaves ranking entries alone when clips are split, deleted, fitted, undone and redone', () => {
    addToTimeline(item('m-a', 3))
    addToTimeline(item('m-b', 6, true))
    const entries = [
      { id: 'r1', label: 'Over a', time: { start: 0, end: 3 } },
      { id: 'r2', label: 'Over b', time: { start: 3.5, end: 8 } },
      { id: 'r3', label: 'No time', time: null },
    ]
    updateProject((p) => {
      p.ranking.entries = structuredClone(entries)
    })
    const ranked = () => useProjectStore.getState().project.ranking.entries

    setUi({ playhead: 5, selectedClipId: null })
    splitAtPlayhead()
    setUi({ selectedClipId: clips()[0].id })
    deleteSelected()
    fitClips()
    expect(spans()).not.toEqual(['m-a@0-3', 'm-b@3-9'])
    expect(ranked()).toEqual(entries)
    undo()
    undo()
    undo()
    redo()
    expect(ranked()).toEqual(entries)
  })

  it('starts a fresh history for another project', () => {
    addToTimeline(item('m-a', 3))
    useProjectStore.getState().replace(createProject())
    expect(useTimelineHistory.getState().past).toEqual([])
  })
})
