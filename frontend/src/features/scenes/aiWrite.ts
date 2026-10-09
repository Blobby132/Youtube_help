// Write scenes with AI, the app's side, as pure functions (aiWrite.test.ts). The backend asks the
// language model (backend/app/llm/writer.py) and splits its answer into fields to fill in and
// fields you've edited, which it only offers. A run takes a while and you can keep working, so the
// answer is checked against the scenes as they are when it arrives: a field you edited meanwhile is
// asked about too, and a merge or split of a scene whose times changed is left out. What you choose
// then goes in as one undo step.
import type { AiMerge, AiSplit, AiTexts, PromptRequest, WriteResult, WriteScene } from '../../lib/api'
import { newId } from '../../lib/ids'
import { formatTimecode } from '../../lib/time'
import type { Project, Scene, SceneSource, SceneTextField } from '../../state/project/types'
import { editedFields, isEdited, newScene, sortScenes } from './sceneOps'
import { narration, sceneTiming, wordsIn } from './scenePlan'

export const FIELD_LABEL: Record<SceneTextField, string> = {
  source: 'Source',
  description: 'Visual description',
  searchText: 'Stock search text',
  prompt: 'ComfyUI prompt',
}

export const SOURCE_LABEL: Record<SceneSource, string> = { ai: 'AI', stock: 'Stock', none: 'None' }

const round = (n: number) => Math.round(n * 1e4) / 1e4

/** What Write scenes with AI sends: the script, and each scene with its words (and their times,
 * where a split can cut), its fields and which of them you've edited. */
export function writeRequest(project: Pick<Project, 'script' | 'voiceover' | 'captions' | 'scenes'>): { script: string; scenes: WriteScene[] } {
  const timing = sceneTiming(project)
  return {
    script: project.script,
    scenes: project.scenes.map((scene) => ({
      id: scene.id,
      start: scene.start,
      end: scene.end,
      words: wordsIn(timing.words, scene).map(({ text, start, end }) => ({ text, start: round(start), end: round(end) })),
      source: scene.source,
      description: scene.description,
      prompt: scene.prompt,
      searchText: scene.searchText,
      edited: editedFields(scene),
    })),
  }
}

/** What Rewrite prompt sends for one scene (null if it's gone). */
export function promptRequest(project: Pick<Project, 'script' | 'voiceover' | 'captions' | 'scenes'>, sceneId: string): PromptRequest | null {
  const index = project.scenes.findIndex((s) => s.id === sceneId)
  if (index < 0) return null
  const scene = project.scenes[index]
  const around = (other: Scene | undefined) => other?.description.trim() || null
  return {
    script: project.script,
    scene: {
      number: index + 1,
      start: scene.start,
      end: scene.end,
      narration: narration(sceneTiming(project).words, scene),
      description: scene.description,
      prompt: scene.prompt,
      before: around(project.scenes[index - 1]),
      after: around(project.scenes[index + 1]),
    },
  }
}

/** A field you've edited that the AI has other text for. */
export interface Question {
  key: string
  sceneId: string
  number: number
  field: SceneTextField
  mine: string
  ai: string
}

export interface MergeOffer extends AiMerge {
  key: string
  /** The first scene's number. */
  number: number
}

export interface SplitOffer extends AiSplit {
  key: string
  number: number
  start: number
  end: number
}

export interface Review {
  /** The AI's text that goes straight in, by scene. */
  fills: { sceneId: string; texts: Partial<AiTexts> }[]
  /** How many of the AI's scenes are still there. */
  written: number
  questions: Question[]
  merges: MergeOffer[]
  splits: SplitOffer[]
  /** Merges and splits left out, and why. */
  skipped: string[]
}

export interface Choices {
  /** Questions answered "use the AI's" (their keys); the others keep yours. */
  useAi: readonly string[]
  /** The merges and splits to make (their keys). */
  merges: readonly string[]
  splits: readonly string[]
}

const questionKey = (sceneId: string, field: SceneTextField) => `${sceneId}:${field}`

/**
 * The AI's answer against the scenes as they are now (`current`), given the ones it was written
 * for (`sent`). A field it would fill in that you've edited since it was sent becomes a question,
 * and so does every field it offers instead of overwriting; a merge or split of scenes whose times
 * changed is left out.
 */
export function reviewWrite(current: readonly Scene[], sent: readonly Scene[], result: WriteResult): Review {
  const scenes = sortScenes(current)
  const byId = new Map(scenes.map((scene, i) => [scene.id, { scene, number: i + 1 }]))
  const sentById = new Map(sent.map((scene) => [scene.id, scene]))
  const review: Review = { fills: [], written: 0, questions: [], merges: [], splits: [], skipped: [...result.skipped] }

  for (const answer of result.scenes) {
    const found = byId.get(answer.id)
    if (!found) continue // deleted while the model was writing
    const { scene, number } = found
    const before = sentById.get(answer.id)
    const texts: Partial<AiTexts> = {}
    const ask = (field: SceneTextField, ai: string) =>
      review.questions.push({ key: questionKey(scene.id, field), sceneId: scene.id, number, field, mine: scene[field], ai })
    for (const [field, ai] of Object.entries(answer.set) as [SceneTextField, string][]) {
      const changed = before !== undefined && scene[field] !== before[field]
      if (changed && isEdited(scene, field) && scene[field] !== ai) ask(field, ai)
      else Object.assign(texts, { [field]: ai })
    }
    for (const [field, ai] of Object.entries(answer.ask) as [SceneTextField, string][]) {
      if (scene[field] === ai) continue
      // Cleared (or put back as the AI wrote it) meanwhile: nothing of yours to keep.
      if (isEdited(scene, field)) ask(field, ai)
      else Object.assign(texts, { [field]: ai })
    }
    review.written++
    if (Object.keys(texts).length) review.fills.push({ sceneId: scene.id, texts })
  }

  const unchanged = (id: string) => {
    const now = byId.get(id)?.scene
    const then = sentById.get(id)
    return !!now && !!then && now.start === then.start && now.end === then.end
  }
  for (const merge of result.merges) {
    const first = byId.get(merge.id)
    const next = first && scenes[first.number]
    if (!first || next?.id !== merge.next || !unchanged(merge.id) || !unchanged(merge.next)) {
      review.skipped.push(`A merge of ${first ? `scene ${first.number} with the next` : 'two scenes'} was left out: the scenes changed while the language model was writing.`)
      continue
    }
    // Your text in the next scene that the merged one would replace, as it is now.
    const replacesEdits = editedFields(next).filter((field) => field !== 'source' && next[field].trim())
    review.merges.push({ ...merge, replacesEdits, key: `merge:${merge.id}`, number: first.number })
  }
  for (const split of result.splits) {
    const found = byId.get(split.id)
    if (!found || !unchanged(split.id)) {
      review.skipped.push(`A split of ${found ? `scene ${found.number}` : 'a scene'} was left out: it changed while the language model was writing.`)
      continue
    }
    review.splits.push({ ...split, key: `split:${split.id}`, number: found.number, start: found.scene.start, end: found.scene.end })
  }
  return review
}

/** Whether the review needs your answers (else it can go straight in). */
export const needsAnswers = (review: Review) => review.questions.length > 0 || review.merges.length > 0 || review.splits.length > 0

/** What the review dialog starts with: your text kept, the AI's merges and splits made, except a
 * merge that would replace text you wrote. */
export function defaultChoices(review: Review): Choices {
  return {
    useAi: [],
    merges: review.merges.filter((m) => !m.replacesEdits.length).map((m) => m.key),
    splits: review.splits.map((s) => s.key),
  }
}

/** The scenes with the AI's text and your choices: one new list, for one undo step. */
export function applyWrite(current: readonly Scene[], review: Review, choices: Choices, makeId: () => string = () => newId('s')): Scene[] {
  const texts = new Map(review.fills.map((fill) => [fill.sceneId, { ...fill.texts }]))
  for (const question of review.questions) {
    if (!choices.useAi.includes(question.key)) continue
    texts.set(question.sceneId, { ...texts.get(question.sceneId), [question.field]: question.ai })
  }
  const scenes = sortScenes(current).map((scene) => {
    const written = texts.get(scene.id)
    return written ? { ...scene, ...written, aiWritten: { ...scene.aiWritten, ...written } } : scene
  })
  for (const split of review.splits) {
    const index = scenes.findIndex((s) => s.id === split.id)
    if (!choices.splits.includes(split.key) || index < 0) continue
    const scene = scenes[index]
    const second: Scene = {
      ...newScene(makeId(), split.at, scene.end),
      ...split.second,
      previewCount: scene.previewCount,
      aiWritten: { ...split.second },
    }
    scenes.splice(index, 1, { ...scene, end: round(split.at) }, second)
  }
  for (const merge of review.merges) {
    const index = scenes.findIndex((s) => s.id === merge.id)
    const next = scenes[index + 1]
    if (!choices.merges.includes(merge.key) || index < 0 || next?.id !== merge.next) continue
    // The first scene, with the AI's text for the whole stretch, keeps its id and previews.
    scenes.splice(index, 2, { ...scenes[index], end: next.end, stockItemId: scenes[index].stockItemId ?? next.stockItemId })
  }
  return scenes
}

/** "Merge scenes 3 and 4 (0:06.00–0:10.50, 4.5 s)" */
export function describeMerge(merge: MergeOffer): string {
  return `Merge scenes ${merge.number} and ${merge.number + 1} (${formatTimecode(merge.start)}–${formatTimecode(merge.end)}, ${(merge.end - merge.start).toFixed(1)} s)`
}

/** "Split scene 5 at 0:14.20, before “the outer pane” (2.4 s and 2.6 s)" */
export function describeSplit(split: SplitOffer): string {
  return `Split scene ${split.number} at ${formatTimecode(split.at)}, before “${split.before}” (${(split.at - split.start).toFixed(1)} s and ${(split.end - split.at).toFixed(1)} s)`
}

/** What a finished run changed, in one sentence. */
export function writeSummary(result: WriteResult, review: Review, choices: Choices): string {
  const kept = review.questions.filter((q) => !choices.useAi.includes(q.key)).length
  const merged = review.merges.filter((m) => choices.merges.includes(m.key)).length
  const split = review.splits.filter((s) => choices.splits.includes(s.key)).length
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const parts = [
    kept && `kept ${plural(kept, 'field', 'fields')} you edited`,
    merged && `merged ${plural(merged, 'pair', 'pairs')} of scenes`,
    split && `split ${plural(split, 'scene', 'scenes')}`,
  ].filter(Boolean)
  const tail = parts.length ? `, ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}` : ''
  return `Wrote ${plural(review.written, 'scene', 'scenes')} with ${result.model}${tail}. Undo (Ctrl+Z) brings back what was there.`
}
