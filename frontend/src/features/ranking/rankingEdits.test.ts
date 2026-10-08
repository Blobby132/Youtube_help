import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryItem } from '../../lib/api'
import { createProject } from '../../state/project/defaults'
import { useProjectStore } from '../../state/project/store'
import type { Ranking } from '../../state/project/types'
import { setUi } from '../../state/ui'
import { useLibrary } from '../library/libraryStore'
import { addToTimeline, redo, splitAtPlayhead, undo, useTimelineHistory } from '../timeline/timelineEdits'
import { resizeEntry } from './rankEntries'
import {
  addEntry,
  removeEntry,
  reorderEntry,
  retimeEntry,
  setEntries,
  setEntryTime,
  setRanking,
  setRankStyle,
  updateEntry,
} from './rankingEdits'

const video: LibraryItem = {
  id: 'm-a',
  kind: 'video',
  name: 'm-a',
  file: 'm-a.mp4',
  thumbnail: null,
  width: 1080,
  height: 1920,
  duration: 4,
  fps: 30,
  hasAudio: false,
  size: 1,
  source: 'upload',
  aiGenerated: false,
  lowRes: false,
  originalName: null,
  addedAt: '',
  pexels: null,
  pixabay: null,
  generation: null,
}

const ranking = () => useProjectStore.getState().project.ranking
const clipCount = () => useProjectStore.getState().project.clips.length
const steps = () => useTimelineHistory.getState().past.length
const times = () => ranking().entries.map((e) => e.time && [e.time.start, e.time.end])
const labels = () => ranking().entries.map((e) => e.label)

beforeEach(() => {
  const project = createProject()
  project.voiceover = { source: 'ai', file: 'v.wav', duration: 20 }
  useProjectStore.getState().replace(project)
  useLibrary.setState({ items: [video], status: 'ready' })
  useTimelineHistory.setState({ past: [], future: [], notice: null })
  setUi({ selectedClipId: null, playhead: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ranking undo', () => {
  it('Undo removes an added entry and Redo brings it back', () => {
    const id = addEntry()
    expect(ranking().entries.map((e) => e.id)).toEqual([id])
    undo()
    expect(ranking().entries).toEqual([])
    redo()
    expect(ranking().entries.map((e) => e.id)).toEqual([id])
    expect(times()).toEqual([[0, 3]])
  })

  it('every kind of ranking change is one undo step, undone and redone in order', () => {
    vi.useFakeTimers()
    // The project as it is after each step: undoing goes back through them, redoing forward.
    const states: Ranking[] = [ranking()]
    const step = (change: () => void) => {
      change()
      states.push(ranking())
      // Far enough apart that nothing merges with the step before.
      vi.advanceTimersByTime(5000)
    }

    let first = ''
    let second = ''
    step(() => (first = addEntry()))
    step(() => (second = addEntry()))
    step(() => updateEntry(first, { label: 'Boeing 747' }, 'label'))
    step(() => reorderEntry(1, 0))
    step(() => setRanking({ direction: 'up' }))
    step(() => setRanking({ enabled: false }))
    step(() => setRankStyle({ size: 240 }, 'size'))
    step(() => setRankStyle({ fontId: 'bebas' }))
    step(() => setRankStyle({ numberColor: '#ff0000' }, 'numberColor'))
    // first is at 0-3 s, second right after it at 3-6 s.
    step(() => expect(setEntryTime(first, 'start', '0:00.50')).toBeNull())
    step(() => setEntries(resizeEntry(ranking().entries, second, 'end', 5)))
    step(() => {
      setUi({ playhead: 10 })
      retimeEntry(second)
    })
    step(() => removeEntry(first))

    expect(steps()).toBe(states.length - 1)
    for (let i = states.length - 2; i >= 0; i--) {
      undo()
      expect(ranking(), `undo back to state ${i}`).toEqual(states[i])
    }
    expect(steps()).toBe(0)
    for (let i = 1; i < states.length; i++) {
      redo()
      expect(ranking(), `redo to state ${i}`).toEqual(states[i])
    }
  })

  it('typing a label undoes as one step; a pause starts a new one', () => {
    vi.useFakeTimers()
    const id = addEntry()
    for (const label of ['B', 'Bo', 'Boe', 'Boeing']) {
      updateEntry(id, { label }, 'label')
      vi.advanceTimersByTime(300)
    }
    vi.advanceTimersByTime(5000)
    updateEntry(id, { label: 'Boeing 747' }, 'label')
    expect(steps()).toBe(3)
    undo()
    expect(labels()).toEqual(['Boeing'])
    undo()
    expect(labels()).toEqual([''])
    undo()
    expect(labels()).toEqual([])
  })

  it('a slider drag on the look undoes as one step', () => {
    for (const size of [210, 220, 230]) setRankStyle({ size }, 'size')
    expect(steps()).toBe(1)
    undo()
    expect(ranking().style.size).toBe(createProject().ranking.style.size)
  })

  it('changes that change nothing add no undo step', () => {
    const id = addEntry()
    setRanking({ direction: ranking().direction })
    updateEntry(id, { label: '' })
    reorderEntry(0, 0)
    removeEntry('missing')
    setEntries(ranking().entries)
    expect(steps()).toBe(1)
  })

  it('clip and ranking edits undo together, in the order they were made', () => {
    addToTimeline(video)
    const id = addEntry()
    setUi({ selectedClipId: null, playhead: 2 })
    splitAtPlayhead()
    expect(clipCount()).toBe(2)

    undo()
    expect(clipCount()).toBe(1)
    expect(ranking().entries.map((e) => e.id)).toEqual([id])
    undo()
    expect(clipCount()).toBe(1)
    expect(ranking().entries).toEqual([])
    undo()
    expect(clipCount()).toBe(0)
    redo()
    redo()
    expect(clipCount()).toBe(1)
    expect(ranking().entries.map((e) => e.id)).toEqual([id])
  })

  it('a new edit after Undo clears Redo', () => {
    addEntry()
    undo()
    expect(useTimelineHistory.getState().future).toHaveLength(1)
    setRanking({ direction: 'up' })
    expect(useTimelineHistory.getState().future).toEqual([])
  })
})

describe('typed times', () => {
  beforeEach(() => {
    // #2 at 0-3 s and #1 at 5-8 s, counting down.
    const a = addEntry()
    setUi({ playhead: 5 })
    const b = addEntry()
    updateEntry(a, { label: 'Boeing 747' })
    updateEntry(b, { label: 'Airbus A380' })
    useTimelineHistory.setState({ past: [], future: [] })
  })

  const [a, b] = [0, 1].map((i) => () => ranking().entries[i].id)

  it('applies a time typed as minutes and seconds or as seconds, as one undo step each', () => {
    expect(setEntryTime(a(), 'start', '0:00.50')).toBeNull()
    expect(setEntryTime(a(), 'end', '3.04')).toBeNull()
    expect(times()).toEqual([[0.5, 3.04], [5, 8]])
    undo()
    expect(times()).toEqual([[0.5, 3], [5, 8]])
    undo()
    expect(times()).toEqual([[0, 3], [5, 8]])
    redo()
    redo()
    expect(times()).toEqual([[0.5, 3.04], [5, 8]])
  })

  it('a time that can’t be used says why, changes nothing and adds no undo step', () => {
    const before = ranking()
    expect(setEntryTime(a(), 'end', 'abc')).toBe('“abc” isn’t a time. Type minutes and seconds like 0:03.04, or seconds like 3.04.')
    expect(setEntryTime(a(), 'start', ' ')).toBe('Type a start time. Type minutes and seconds like 0:03.04, or seconds like 3.04.')
    expect(setEntryTime(a(), 'end', '')).toMatch(/^Type an end time\./)
    expect(setEntryTime(b(), 'end', '4')).toBe('The end has to be after the start (0:05.00). To move the entry earlier, change its start first.')
    expect(setEntryTime(a(), 'start', '0:03.10')).toBe(
      'The start has to be before the end (0:03.00). To move the entry later, change its end first.',
    )
    expect(setEntryTime(a(), 'end', '6')).toBe('That overlaps #1 Airbus A380 (0:05.00–0:08.00). Entries can’t overlap.')
    expect(setEntryTime(b(), 'start', '0:02.99')).toBe('That overlaps #2 Boeing 747 (0:00.00–0:03.00). Entries can’t overlap.')
    expect(ranking()).toBe(before)
    expect(steps()).toBe(0)
  })

  it('the same time again changes nothing', () => {
    expect(setEntryTime(a(), 'end', '0:03.00')).toBeNull()
    expect(steps()).toBe(0)
  })
})
