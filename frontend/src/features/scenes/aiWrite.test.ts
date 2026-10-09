import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Job, type LlmStatus, type PromptResult, type WriteResult } from '../../lib/api'
import { createProject } from '../../state/project/defaults'
import { useProjectStore } from '../../state/project/store'
import type { CaptionWord, Scene } from '../../state/project/types'
import { setUi } from '../../state/ui'
import { useGenerate } from '../generate/generateStore'
import { undo, useTimelineHistory } from '../timeline/timelineEdits'
import { applyWrite, defaultChoices, describeMerge, describeSplit, promptRequest, reviewWrite, writeRequest, writeSummary } from './aiWrite'
import { applyReview, comfyJobsActive, llmBlocker, rewriteScenePrompt, setChoice, useLlm, writeScenesWithAi } from './llmStore'
import { updateScene } from './sceneEdits'
import { editedFields, isEdited, mergeWithNext, newScene } from './sceneOps'

const scene = (id: string, start: number, end: number, patch: Partial<Scene> = {}): Scene => ({ ...newScene(id, start, end), ...patch })

const AI = { source: 'ai', description: 'A plane window', searchText: 'plane window', prompt: 'Close-up of a plane window. Sound: hum.' } as const

function result(patch: Partial<WriteResult> = {}): WriteResult {
  return { scenes: [], merges: [], splits: [], skipped: [], model: 'qwen/qwen3-8b', attempts: 1, requests: 1, notes: [], ...patch }
}

describe('which fields you have edited', () => {
  it('is any text that isn’t empty and isn’t what the AI wrote, and a source other than its own', () => {
    expect(editedFields(scene('a', 0, 3))).toEqual([]) // new: AI source, empty texts
    expect(editedFields(scene('a', 0, 3, { description: 'Mine', source: 'stock' }))).toEqual(['source', 'description'])
    const written = scene('a', 0, 3, { ...AI, aiWritten: { ...AI } })
    expect(editedFields(written)).toEqual([])
    expect(editedFields({ ...written, prompt: `${AI.prompt} Slow motion.`, source: 'none' })).toEqual(['source', 'prompt'])
    // Clearing a field gives it back to the AI.
    expect(isEdited({ ...written, description: '' }, 'description')).toBe(false)
  })

  it('merging two scenes keeps each text’s author', () => {
    const [merged] = mergeWithNext([scene('a', 0, 2, { prompt: 'Mine' }), scene('b', 2, 4, { description: 'AI text', aiWritten: { description: 'AI text' } })], 'a')!
    expect(merged).toMatchObject({ prompt: 'Mine', description: 'AI text', aiWritten: { description: 'AI text' } })
    expect(editedFields(merged)).toEqual(['prompt'])
  })
})

describe('the request', () => {
  it('sends each scene with its words and times and the fields you edited', () => {
    const project = createProject()
    project.script = 'One two three. Four five.'
    project.voiceover = { source: 'ai', file: 'v.wav', duration: 5 }
    project.captions.voiceoverFile = 'v.wav'
    project.captions.words = ['One', 'two', 'three.', 'Four', 'five.'].map((text, i): CaptionWord => ({ id: `w${i}`, text, start: i, end: i + 0.8 }))
    project.scenes = [scene('a', 0, 3, { description: 'Mine' }), scene('b', 3, 5, { source: 'stock', aiWritten: { source: 'stock' } })]
    const body = writeRequest(project)
    expect(body.script).toBe(project.script)
    expect(body.scenes.map((s) => [s.id, s.words.map((w) => w.text).join(' '), s.edited])).toEqual([
      ['a', 'One two three.', ['description']],
      ['b', 'Four five.', []],
    ])
    expect(body.scenes[1].words[0]).toEqual({ text: 'Four', start: 3, end: 3.8 })

    expect(promptRequest(project, 'b')!.scene).toEqual({ number: 2, start: 3, end: 5, narration: 'Four five.', description: '', prompt: '', before: 'Mine', after: null })
  })
})

describe('reviewing and applying the answer', () => {
  const sent = [scene('a', 0, 3), scene('b', 3, 6, { description: 'My window', aiWritten: {} }), scene('c', 6, 8)]
  const answer = result({
    scenes: [
      { id: 'a', set: { ...AI }, ask: {} },
      { id: 'b', set: { source: 'stock', searchText: 'window', prompt: 'P2' }, ask: { description: 'AI window' } },
      { id: 'c', set: { source: 'ai', description: 'D3', searchText: 'S3', prompt: 'P3' }, ask: {} },
    ],
  })

  it('fills in what you haven’t edited and asks about the rest, keeping yours unless you choose the AI’s', () => {
    const review = reviewWrite(sent, sent, answer)
    expect(review.questions).toEqual([{ key: 'b:description', sceneId: 'b', number: 2, field: 'description', mine: 'My window', ai: 'AI window' }])
    const kept = applyWrite(sent, review, defaultChoices(review))
    expect(kept[0]).toMatchObject({ ...AI, aiWritten: AI })
    expect(kept[1]).toMatchObject({ source: 'stock', description: 'My window', searchText: 'window', prompt: 'P2' })
    expect(isEdited(kept[1], 'description')).toBe(true)
    expect(kept[2].aiWritten).toEqual({ source: 'ai', description: 'D3', searchText: 'S3', prompt: 'P3' })

    const replaced = applyWrite(sent, review, { ...defaultChoices(review), useAi: ['b:description'] })
    expect(replaced[1]).toMatchObject({ description: 'AI window', aiWritten: { description: 'AI window' } })
    expect(writeSummary(answer, review, defaultChoices(review))).toBe(
      'Wrote 3 scenes with qwen/qwen3-8b, kept 1 field you edited. Undo (Ctrl+Z) brings back what was there.',
    )
  })

  it('asks about a field you edited while the model was writing, and fills one you cleared', () => {
    const now = [scene('a', 0, 3, { prompt: 'Typed meanwhile' }), { ...sent[1], description: '' }, sent[2]]
    const review = reviewWrite(now, sent, answer)
    expect(review.questions.map((q) => [q.key, q.mine, q.ai])).toEqual([['a:prompt', 'Typed meanwhile', AI.prompt]])
    const applied = applyWrite(now, review, defaultChoices(review))
    expect(applied[0].prompt).toBe('Typed meanwhile')
    expect(applied[0].description).toBe(AI.description)
    expect(applied[1].description).toBe('AI window')
    // A scene deleted meanwhile is left alone.
    expect(reviewWrite([sent[0], sent[2]], sent, answer).written).toBe(2)
  })

  it('merges and splits the scenes you tick, keeping ids, previews and the 2 to 5 second cuts the backend checked', () => {
    const scenes = [scene('a', 0, 2, { selectedPreviewId: 'v1' }), scene('b', 2, 4), scene('c', 4, 9, { previewCount: 3 })]
    const second = { source: 'stock', description: 'D4', searchText: 'S4', prompt: 'P4' } as const
    const withChanges = result({
      scenes: [
        { id: 'a', set: { description: 'Both' }, ask: {} },
        { id: 'c', set: { description: 'First half' }, ask: {} },
      ],
      merges: [{ id: 'a', next: 'b', start: 0, end: 4, why: 'One shot.', replacesEdits: [] }],
      splits: [{ id: 'c', at: 6.5, before: 'the outer pane', second, why: 'Two ideas.' }],
    })
    const review = reviewWrite(scenes, scenes, withChanges)
    expect(describeMerge(review.merges[0])).toBe('Merge scenes 1 and 2 (0:00.00–0:04.00, 4.0 s)')
    expect(describeSplit(review.splits[0])).toBe('Split scene 3 at 0:06.50, before “the outer pane” (2.5 s and 2.5 s)')
    const choices = defaultChoices(review)
    expect(choices).toEqual({ useAi: [], merges: ['merge:a'], splits: ['split:c'] })
    const applied = applyWrite(scenes, review, choices, () => 's-new')
    expect(applied.map((s) => [s.id, s.start, s.end, s.description])).toEqual([
      ['a', 0, 4, 'Both'],
      ['c', 4, 6.5, 'First half'],
      ['s-new', 6.5, 9, 'D4'],
    ])
    expect(applied[0].selectedPreviewId).toBe('v1')
    expect(applied[2]).toMatchObject({ source: 'stock', previewCount: 3, aiWritten: second })
    expect(writeSummary(withChanges, review, choices)).toBe(
      'Wrote 2 scenes with qwen/qwen3-8b, merged 1 pair of scenes and split 1 scene. Undo (Ctrl+Z) brings back what was there.',
    )
    // Unticked: nothing moves.
    expect(applyWrite(scenes, review, { useAi: [], merges: [], splits: [] }).map((s) => [s.id, s.end])).toEqual([
      ['a', 2],
      ['b', 4],
      ['c', 9],
    ])
  })

  it('leaves out changes to scenes whose times changed, and a merge over your text starts unticked', () => {
    const scenes = [scene('a', 0, 2), scene('b', 2, 4, { description: 'Mine' }), scene('c', 4, 9)]
    const changes = result({
      merges: [{ id: 'a', next: 'b', start: 0, end: 4, why: '', replacesEdits: [] }],
      splits: [{ id: 'c', at: 6.5, before: 'x', second: { ...AI }, why: '' }],
    })
    const moved = [scenes[0], scenes[1], { ...scenes[2], end: 8.5 }]
    const review = reviewWrite(moved, scenes, changes)
    expect(review.merges[0].replacesEdits).toEqual(['description'])
    expect(defaultChoices(review).merges).toEqual([])
    expect(review.splits).toEqual([])
    expect(review.skipped).toEqual(['A split of scene 3 was left out: it changed while the language model was writing.'])
  })
})

describe('when it can run', () => {
  const status: LlmStatus = {
    reachable: true,
    url: 'http://127.0.0.1:1234/v1',
    model: 'qwen/qwen3-8b',
    error: null,
    modelProblem: null,
    comfy: { reachable: true, running: 0, pending: 0, busy: null },
    running: false,
    guide: 'ltx_guide.md',
    guideProblem: null,
  }

  it('waits while ComfyUI generates, saying why', () => {
    expect(llmBlocker(status, true, 0)).toBeNull()
    expect(llmBlocker({ ...status, comfy: { ...status.comfy, running: 1, busy: 'ComfyUI is generating (1 job in its queue)…' } }, true, 0)).toBe(
      'ComfyUI is generating (1 job in its queue)…',
    )
    // The app's own jobs count straight away, before the next status check.
    expect(llmBlocker(status, true, 2)).toBe(
      "ComfyUI is generating (2 jobs in its queue), so the language model waits until it's done. The language model and ComfyUI share the GPU, and running both at once can run out of video memory or slow both to a crawl.",
    )
    expect(comfyJobsActive([{ status: 'running' }, { status: 'saving' }, { status: 'done' }] as never)).toBe(1)
    expect(llmBlocker({ ...status, reachable: false }, true, 0)).toBe('Start the language model server first (LM Studio or Ollama): Write with AI uses it.')
    expect(llmBlocker({ ...status, modelProblem: 'Set LLM_MODEL' }, true, 0)).toBe('Set LLM_MODEL')
  })
})

describe('Write scenes with AI and Rewrite prompt, start to finish', () => {
  const project = () => useProjectStore.getState().project
  let confirm = vi.fn(() => true)

  function done<T>(value: T): Job<T> {
    return { id: 'job-1', kind: 'llm', status: 'done', progress: 1, message: 'Done', result: value, error: null }
  }

  beforeEach(() => {
    const fresh = createProject()
    fresh.script = 'One two three. Four five six.'
    fresh.voiceover = { source: 'ai', file: 'v.wav', duration: 6 }
    fresh.scenes = [scene('a', 0, 3), scene('b', 3, 6, { description: 'Mine' })]
    useProjectStore.getState().replace(fresh)
    useTimelineHistory.setState({ past: [], future: [], notice: null })
    useLlm.setState({ run: null, pending: null, reviewOpen: false, done: null, failure: null, promptFailures: {} })
    useGenerate.setState({ jobs: [] })
    setUi({ backend: 'online' })
    vi.spyOn(api, 'llmStatus').mockRejectedValue(new Error('not needed'))
    vi.spyOn(api, 'comfyStatus').mockRejectedValue(new Error('not needed'))
    confirm = vi.fn(() => true)
    vi.stubGlobal('window', { confirm })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('goes straight in when there’s nothing to ask, as one undo step', async () => {
    const write = vi.spyOn(api, 'writeScenes').mockResolvedValue(
      done(result({ scenes: [{ id: 'a', set: { ...AI }, ask: {} }], notes: ['Unloaded qwen/qwen3-8b from LM Studio.'] })),
    )
    await writeScenesWithAi()
    expect(write.mock.calls[0][0].scenes.map((s) => s.edited)).toEqual([[], ['description']])
    expect(project().scenes[0]).toMatchObject(AI)
    expect(useLlm.getState().done).toEqual({
      message: 'Wrote 1 scene with qwen/qwen3-8b. Undo (Ctrl+Z) brings back what was there.',
      skipped: [],
      notes: ['Unloaded qwen/qwen3-8b from LM Studio.'],
    })
    expect(useTimelineHistory.getState().past).toHaveLength(1)
    undo()
    expect(project().scenes[0].description).toBe('')
  })

  it('asks about your edited fields first, and keeps the answer until you apply it', async () => {
    vi.spyOn(api, 'writeScenes').mockResolvedValue(done(result({ scenes: [{ id: 'b', set: { prompt: 'P2' }, ask: { description: 'AI text' } }] })))
    await writeScenesWithAi()
    expect(useLlm.getState()).toMatchObject({ reviewOpen: true, run: null })
    expect(project().scenes[1].prompt).toBe('') // nothing yet
    setChoice('useAi', 'b:description', true)
    applyReview()
    expect(project().scenes[1]).toMatchObject({ description: 'AI text', prompt: 'P2' })
    expect(useLlm.getState().pending).toBeNull()
    undo()
    expect(project().scenes[1]).toMatchObject({ description: 'Mine', prompt: '' })
  })

  it('shows what the model wrote when its answer couldn’t be used', async () => {
    vi.spyOn(api, 'writeScenes').mockResolvedValue({
      ...done(null),
      status: 'error',
      error: 'The language model’s answer couldn’t be used, even after asking again: scene 2 is missing.',
      errorData: { raw: ['{"scenes": []}', 'Sorry.'] },
    })
    await writeScenesWithAi()
    expect(useLlm.getState().failure).toEqual({
      message: 'The language model’s answer couldn’t be used, even after asking again: scene 2 is missing.',
      raw: ['{"scenes": []}', 'Sorry.'],
    })
    expect(project().scenes[0].description).toBe('')
  })

  it('Rewrite prompt asks before replacing your own prompt, and Undo brings it back', async () => {
    const rewrite = vi.spyOn(api, 'rewritePrompt').mockResolvedValue(done<PromptResult>({ prompt: 'New prompt', model: 'm', attempts: 1, notes: [] }))
    await rewriteScenePrompt('a')
    expect(confirm).not.toHaveBeenCalled() // an empty prompt isn't yours
    expect(project().scenes[0]).toMatchObject({ prompt: 'New prompt', aiWritten: { prompt: 'New prompt' } })
    expect(rewrite.mock.calls[0][0].scene).toMatchObject({ number: 1, after: 'Mine' })

    updateScene('a', { prompt: 'My prompt' })
    confirm.mockReturnValueOnce(false)
    await rewriteScenePrompt('a')
    expect(confirm).toHaveBeenCalledWith('Scene 1’s prompt has your own text. Rewrite it with the language model? Undo (Ctrl+Z) brings yours back.')
    expect(rewrite).toHaveBeenCalledTimes(1)
    await rewriteScenePrompt('a')
    expect(project().scenes[0].prompt).toBe('New prompt')
    undo()
    expect(project().scenes[0].prompt).toBe('My prompt')
  })
})
