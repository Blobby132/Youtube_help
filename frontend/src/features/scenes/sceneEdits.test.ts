import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryItem } from '../../lib/api'
import { createProject } from '../../state/project/defaults'
import { useProjectStore } from '../../state/project/store'
import type { CaptionWord, Scene } from '../../state/project/types'
import { setUi, useUi } from '../../state/ui'
import { useLibrary } from '../library/libraryStore'
import { addEntry } from '../ranking/rankingEdits'
import { addToTimeline, redo, undo, useTimelineHistory } from '../timeline/timelineEdits'
import {
  addSceneAtPlayhead,
  createScenes,
  mergeScene,
  removeScene,
  selectPreview,
  setPreviewCount,
  setScenes,
  setSceneTime,
  splitSceneAt,
  updateScene,
} from './sceneEdits'
import { resizeScene } from './sceneOps'
import { placeFootage } from './sceneStock'

const video = (id: string, duration: number): LibraryItem => ({
  id,
  kind: 'video',
  name: id,
  file: `${id}.mp4`,
  thumbnail: null,
  width: 1080,
  height: 1920,
  duration,
  fps: 30,
  hasAudio: false,
  size: 1,
  source: 'pixabay',
  aiGenerated: false,
  lowRes: false,
  originalName: null,
  addedAt: '',
  pexels: null,
  pixabay: null,
  generation: null,
})

const SCRIPT =
  'Every airplane window has a tiny hole in it. It keeps the window from fogging up. ' +
  'The hole lets air move between the panes. Without it the outer pane would take all the pressure.'

const project = () => useProjectStore.getState().project
const scenes = () => project().scenes
const ranges = () => scenes().map((s) => [s.start, s.end])
const steps = () => useTimelineHistory.getState().past.length

/** Caption words for the script, 0.32 s each with a breath after each sentence. */
function captionWords(script: string): CaptionWord[] {
  let t = 0.2
  return script.split(' ').map((text, i) => {
    const word = { id: `w${i}`, text, start: t, end: t + 0.3 }
    t += /\.$/.test(text) ? 0.62 : 0.32
    return word
  })
}

let confirm = vi.fn(() => true)

beforeEach(() => {
  const fresh = createProject()
  fresh.script = SCRIPT
  fresh.voiceover = { source: 'ai', file: 'v.wav', duration: 12 }
  useProjectStore.getState().replace(fresh)
  useLibrary.setState({ items: [video('m-a', 8), video('m-b', 2)], status: 'ready' })
  useTimelineHistory.setState({ past: [], future: [], notice: null })
  setUi({ selectedClipId: null, selectedSceneId: null, playhead: 0 })
  confirm = vi.fn(() => true)
  vi.stubGlobal('window', { confirm })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('creating scenes', () => {
  it('times scenes with the captions when there are any', () => {
    useProjectStore.getState().update((p) => {
      p.captions.words = captionWords(SCRIPT)
      p.captions.voiceoverFile = 'v.wav'
      p.captions.source = 'script'
    })
    expect(createScenes()).toBeNull()
    const words = project().captions.words
    // Each sentence is 2 to 5 seconds, so every scene starts with a sentence.
    const starts = scenes().slice(1).map((s) => words.find((w) => Math.abs(w.start - s.start) < 1e-6)?.text)
    expect(starts).toEqual(['It', 'The', 'Without'])
    expect(scenes()[0].start).toBe(0)
    expect(scenes()[3].end).toBe(12)
  })

  it('times scenes with the estimate without captions', () => {
    createScenes()
    expect(scenes().length).toBeGreaterThan(1)
    for (const scene of scenes()) expect(scene.end - scene.start).toBeGreaterThanOrEqual(2)
    expect(scenes()[scenes().length - 1].end).toBe(12)
  })

  it('asks before replacing scenes; Undo brings the old ones back', () => {
    createScenes()
    updateScene(scenes()[0].id, { prompt: 'A plane window, close up' })
    const before = scenes()
    confirm.mockReturnValueOnce(false)
    createScenes()
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/^Replace the \d+ scenes with new ones from the script\? Undo/))
    expect(scenes()).toBe(before) // said no: nothing changed

    createScenes()
    expect(scenes()[0].prompt).toBe('')
    undo()
    expect(scenes()).toEqual(before)
    redo()
    expect(scenes()[0].prompt).toBe('')
  })

  it('says why there are no scenes without a script', () => {
    useProjectStore.getState().update((p) => {
      p.script = ''
      p.voiceover = null
    })
    expect(createScenes()).toBe('Write a script first: scenes are made from its sentences.')
    expect(steps()).toBe(0)
  })
})

describe('scene undo', () => {
  it('every kind of scene change is one undo step, undone and redone in order', () => {
    vi.useFakeTimers()
    const states: Scene[][] = [scenes()]
    const step = (change: () => void) => {
      change()
      states.push(scenes())
      vi.advanceTimersByTime(2000) // past the window in which typing merges
    }
    step(() => createScenes())
    const [first, second] = scenes()
    step(() => setSceneTime(first.id, 'end', '3.5'))
    step(() => setScenes(resizeScene(scenes(), second.id, 'end', second.end + 0.4)))
    step(() => splitSceneAt(scenes()[0].id))
    step(() => mergeScene(scenes()[0].id))
    step(() => updateScene(first.id, { source: 'stock' }))
    step(() => updateScene(first.id, { searchText: 'airplane window' }, 'searchText'))
    step(() => setPreviewCount(first.id, 4))
    step(() => selectPreview(first.id, 'v-1'))
    const removed = scenes().find((s) => s.id !== first.id)!
    step(() => removeScene(removed.id))
    setUi({ playhead: removed.start + 0.1 }) // in the time it left free
    step(() => addSceneAtPlayhead())

    expect(steps()).toBe(states.length - 1)
    for (let i = states.length - 2; i >= 0; i--) {
      undo()
      expect(scenes()).toEqual(states[i])
    }
    for (let i = 1; i < states.length; i++) {
      redo()
      expect(scenes()).toEqual(states[i])
    }
  })

  it('typing a prompt undoes as one step', () => {
    createScenes()
    const id = scenes()[0].id
    for (const text of ['A', 'A p', 'A plane']) updateScene(id, { prompt: text }, 'prompt')
    expect(steps()).toBe(2)
    undo()
    expect(scenes()[0].prompt).toBe('')
  })

  it('shares one history with clip and ranking edits, in the order they were made', () => {
    createScenes()
    addToTimeline(useLibrary.getState().items[0])
    addEntry()
    setSceneTime(scenes()[0].id, 'end', '2.5')
    expect(steps()).toBe(4)
    undo() // the scene time
    expect(project().clips).toHaveLength(1)
    expect(project().ranking.entries).toHaveLength(1)
    undo() // the ranking entry
    expect(project().ranking.entries).toHaveLength(0)
    expect(scenes()[0].end).not.toBe(2.5)
    undo() // the clip
    expect(project().clips).toHaveLength(0)
    expect(scenes()).not.toEqual([])
  })

  it('a typed time that can’t be used says why and changes nothing', () => {
    createScenes()
    const id = scenes()[1].id
    expect(setSceneTime(id, 'end', 'soon')).toBe('“soon” isn’t a time. Type minutes and seconds like 0:03.04, or seconds like 3.04.')
    expect(setSceneTime(id, 'start', '')).toBe('Type a start time. Type minutes and seconds like 0:03.04, or seconds like 3.04.')
    expect(setSceneTime(id, 'end', '0:00.10')).toMatch(/^The end has to be after the start/)
    expect(setSceneTime(id, 'start', '0:00.00')).toMatch(/^That leaves scene 1 \(0:00.00–[0-9:.]+\) shorter than 0.5 s/)
    expect(steps()).toBe(1)
  })

  it('Undo drops the selection of a scene it removes', () => {
    const id = addSceneAtPlayhead()!
    expect(useUi.getState().selectedSceneId).toBe(id)
    undo()
    expect(useUi.getState().selectedSceneId).toBeNull()
  })
})

describe('stock footage for a scene', () => {
  it('goes over exactly the scene’s time, and placing it is one undo step', () => {
    createScenes()
    const scene = scenes()[1]
    addToTimeline(useLibrary.getState().items[0]) // 8 s from 0: across the scene
    const clipsBefore = project().clips
    expect(placeFootage(scene.id, useLibrary.getState().items[1])).toBe(true)
    const placed = project().clips.find((c) => c.mediaId === 'm-b')!
    expect([placed.start, placed.start + placed.duration]).toEqual([scene.start, scene.end])
    expect(scenes()[1].stockItemId).toBe('m-b')
    undo()
    expect(project().clips).toEqual(clipsBefore)
    expect(scenes()[1].stockItemId).toBeNull()
  })

  it('times move edges shared with the next scene along', () => {
    createScenes()
    const [a, b] = scenes()
    expect(setSceneTime(a.id, 'end', String(a.end + 0.25))).toBeNull()
    expect(ranges().slice(0, 2)).toEqual([
      [a.start, a.end + 0.25],
      [a.end + 0.25, b.end],
    ])
  })
})
