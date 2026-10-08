import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryItem } from '../../lib/api'
import { createProject } from '../../state/project/defaults'
import { useProjectStore } from '../../state/project/store'
import type { RankEntry } from '../../state/project/types'
import { useLibrary } from '../library/libraryStore'
import { newClip } from '../timeline/clipOps'
import { useTimelineHistory } from '../timeline/timelineEdits'
import { runAutofill } from './autofillTasks'

const item = (id: string): LibraryItem => ({
  id,
  kind: 'video',
  name: id,
  file: `${id}.mp4`,
  thumbnail: null,
  width: 1080,
  height: 1920,
  duration: 20,
  fps: 30,
  hasAudio: false,
  size: 1,
  source: 'pexels',
  aiGenerated: false,
  lowRes: false,
  originalName: null,
  addedAt: '',
  pexels: null,
  pixabay: null,
  generation: null,
})

vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  api: { startAutofill: vi.fn(async () => ({ id: 'job' })) },
}))
vi.mock('../../lib/jobs', () => ({
  waitForJob: vi.fn(async () => ({
    source: 'pexels',
    sentences: [
      { text: 'One.', item: item('m-1') },
      { text: 'Two.', item: item('m-2') },
    ],
  })),
}))

beforeEach(() => {
  vi.stubGlobal('window', { confirm: () => true })
  useLibrary.setState({ items: [], status: 'ready' })
  useTimelineHistory.setState({ past: [], future: [], notice: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Auto-fill', () => {
  it('replaces the clips but leaves ranking entries alone', async () => {
    const project = createProject()
    project.script = 'One. Two.'
    project.voiceover = { source: 'ai', file: 'v.wav', duration: 6 }
    project.clips = [newClip('c-old', 'm-old', 0, 6)]
    const entries: RankEntry[] = [
      { id: 'r1', label: 'First', time: { start: 0.5, end: 2.5 } },
      { id: 'r2', label: 'Second', time: { start: 4, end: 5.5 } },
    ]
    project.ranking.entries = structuredClone(entries)
    useProjectStore.getState().replace(project)

    await runAutofill()

    const after = useProjectStore.getState().project
    expect(after.clips.map((c) => c.mediaId)).toEqual(['m-1', 'm-2'])
    expect(after.ranking.entries).toEqual(entries)
  })
})
