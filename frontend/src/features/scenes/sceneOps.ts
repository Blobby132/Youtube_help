// Scene editing as pure functions: (scenes, ...) -> new scenes, unit tested in sceneOps.test.ts.
// Scenes never overlap and are kept in time order, so a scene's number is its position. Most
// scenes touch the next one (Create scenes leaves no gaps), so an edge shared with a neighbour
// moves the neighbour's edge too, keeping the cut where the two meet. (No store imports: project
// loading uses this file.)
import { newId } from '../../lib/ids'
import { formatTimecode } from '../../lib/time'
import type { PreviewStatus, Scene, ScenePreview, SceneSource, TimeRange } from '../../state/project/types'

/** Shortest scene you can make by hand, in seconds. Create scenes makes them 2 to 5 s long. */
export const MIN_SCENE = 0.5
/** Length of a scene made with Add scene, when there's room. */
export const NEW_SCENE_SECONDS = 3
export const MIN_PREVIEWS = 1
export const MAX_PREVIEWS = 4
export const DEFAULT_PREVIEWS = 2
/** ComfyUI makes 2 to 5 second shots; LTX clips fall apart beyond about 5 seconds. */
export const MIN_SHOT_SECONDS = 2
export const MAX_SHOT_SECONDS = 5

const EPS = 1e-6
const round = (n: number) => Math.round(n * 1e4) / 1e4

export const sceneLength = (scene: TimeRange) => scene.end - scene.start

export const sortScenes = (scenes: readonly Scene[]) => [...scenes].sort((a, b) => a.start - b.start)

export const sceneAt = (scenes: readonly Scene[], time: number) =>
  scenes.find((scene) => time >= scene.start - EPS && time < scene.end - EPS)

/** A scene with nothing filled in yet: AI, two previews. */
export function newScene(id: string, start: number, end: number): Scene {
  return {
    id,
    start: round(start),
    end: round(end),
    source: 'ai',
    description: '',
    prompt: '',
    searchText: '',
    previewCount: DEFAULT_PREVIEWS,
    selectedPreviewId: null,
    stockItemId: null,
  }
}

/** The length of a scene's previews: its own, rounded up to whole seconds, 2 to 5. */
export function previewSeconds(scene: TimeRange): number {
  return Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, Math.ceil(sceneLength(scene) - 1e-3)))
}

/** "scene 3 (0:06.00–0:09.00)" */
function describe(scenes: readonly Scene[], scene: Scene) {
  return `scene ${scenes.indexOf(scene) + 1} (${formatTimecode(scene.start)}–${formatTimecode(scene.end)})`
}

const touches = (a: number, b: number) => Math.abs(a - b) < EPS

/**
 * Drags one edge of a scene to `proposed`. It stops at 0 and MIN_SCENE from its other edge. A
 * neighbour it touches moves along (down to MIN_SCENE long); with `detach`, or a neighbour it
 * doesn't touch, it stops at the neighbour.
 */
export function resizeScene(scenes: readonly Scene[], id: string, edge: 'start' | 'end', proposed: number, detach = false): Scene[] {
  const sorted = sortScenes(scenes)
  const index = sorted.findIndex((s) => s.id === id)
  if (index < 0) return sorted
  const scene = sorted[index]
  if (edge === 'start') {
    const previous = sorted[index - 1]
    const roll = !!previous && !detach && touches(previous.end, scene.start)
    const low = previous ? (roll ? previous.start + MIN_SCENE : previous.end) : 0
    const time = round(Math.min(Math.max(proposed, low), scene.end - MIN_SCENE))
    return sorted.map((s) => (s === scene ? { ...s, start: time } : roll && s === previous ? { ...s, end: time } : s))
  }
  const next = sorted[index + 1]
  const roll = !!next && !detach && touches(next.start, scene.end)
  const high = next ? (roll ? next.end - MIN_SCENE : next.start) : Infinity
  const time = round(Math.max(Math.min(proposed, high), scene.start + MIN_SCENE))
  return sorted.map((s) => (s === scene ? { ...s, end: time } : roll && s === next ? { ...s, start: time } : s))
}

/**
 * Sets one edge of a scene to a typed time. A neighbour it touches moves along, as when
 * dragging; otherwise nothing is stopped short: a time that would end the scene before it
 * starts, make a scene shorter than MIN_SCENE or overlap another scene says why instead.
 */
export function setSceneEdge(
  scenes: readonly Scene[],
  id: string,
  edge: 'start' | 'end',
  seconds: number,
): { scenes: Scene[] } | { error: string } {
  const sorted = sortScenes(scenes)
  const index = sorted.findIndex((s) => s.id === id)
  if (index < 0) return { error: 'That scene no longer exists.' }
  const scene = sorted[index]
  const value = round(seconds)
  const range = edge === 'start' ? { start: value, end: scene.end } : { start: scene.start, end: value }
  if (range.end <= range.start + EPS) {
    return {
      error:
        edge === 'start'
          ? `The start has to be before the end (${formatTimecode(range.end)}). To move the scene later, change its end first.`
          : `The end has to be after the start (${formatTimecode(range.start)}). To move the scene earlier, change its start first.`,
    }
  }
  if (sceneLength(range) < MIN_SCENE - EPS) return { error: `A scene has to be at least ${MIN_SCENE} s long.` }

  const neighbour = edge === 'start' ? sorted[index - 1] : sorted[index + 1]
  const roll = !!neighbour && touches(edge === 'start' ? neighbour.end : neighbour.start, edge === 'start' ? scene.start : scene.end)
  let rolled: Scene | null = null
  if (roll) {
    rolled = edge === 'start' ? { ...neighbour, end: value } : { ...neighbour, start: value }
    if (sceneLength(rolled) < MIN_SCENE - EPS) {
      return { error: `That leaves ${describe(sorted, neighbour)} shorter than ${MIN_SCENE} s. Change or delete that scene first.` }
    }
  }
  const clash = sorted.find(
    (other) => other !== scene && other !== (roll ? neighbour : null) && range.start < other.end - EPS && range.end > other.start + EPS,
  )
  if (clash) return { error: `That overlaps ${describe(sorted, clash)}. Scenes can’t overlap.` }
  return {
    scenes: sorted.map((s) => (s === scene ? { ...s, ...range } : rolled && s === neighbour ? rolled : s)),
  }
}

/**
 * Where Split cuts a scene: at the playhead when it's inside the scene (not too close to an
 * edge), else at the word boundary nearest its middle, else its middle. `wordStarts` are the
 * times words begin.
 */
export function splitPoint(scene: TimeRange, playhead: number, wordStarts: readonly number[]): number | null {
  const low = scene.start + MIN_SCENE
  const high = scene.end - MIN_SCENE
  if (high < low - EPS) return null
  if (playhead >= low - EPS && playhead <= high + EPS) return round(playhead)
  const middle = (scene.start + scene.end) / 2
  const nearest = wordStarts
    .filter((t) => t >= low - EPS && t <= high + EPS)
    .reduce<number | null>((best, t) => (best === null || Math.abs(t - middle) < Math.abs(best - middle) ? t : best), null)
  return round(nearest ?? middle)
}

/**
 * Cuts a scene in two at `time`. The first part keeps the scene (its id, previews and choices);
 * the second is a new scene with the same source and texts. null when `time` is too close to
 * an edge.
 */
export function splitScene(scenes: readonly Scene[], id: string, time: number, secondId: string): Scene[] | null {
  const scene = scenes.find((s) => s.id === id)
  if (!scene || time < scene.start + MIN_SCENE - EPS || time > scene.end - MIN_SCENE + EPS) return null
  const first = { ...scene, end: round(time) }
  const second: Scene = { ...scene, id: secondId, start: round(time), selectedPreviewId: null, stockItemId: null }
  return sortScenes([...scenes.filter((s) => s.id !== id), first, second])
}

/**
 * Joins a scene and the one after it into one scene, from the first's start to the second's
 * end. It keeps the first scene (its id, previews and choices), and takes any text the first
 * doesn't have from the second. null for the last scene.
 */
export function mergeWithNext(scenes: readonly Scene[], id: string): Scene[] | null {
  const sorted = sortScenes(scenes)
  const index = sorted.findIndex((s) => s.id === id)
  const [first, second] = [sorted[index], sorted[index + 1]]
  if (!first || !second) return null
  const merged: Scene = {
    ...first,
    end: second.end,
    description: first.description.trim() ? first.description : second.description,
    prompt: first.prompt.trim() ? first.prompt : second.prompt,
    searchText: first.searchText.trim() ? first.searchText : second.searchText,
    stockItemId: first.stockItemId ?? second.stockItemId,
  }
  return sorted.filter((s) => s !== second).map((s) => (s === first ? merged : s))
}

/** Stretches of 0..`limit` no scene uses. */
function freeSpans(sorted: readonly Scene[], limit: number): TimeRange[] {
  const spans: TimeRange[] = []
  let cursor = 0
  for (const scene of sorted) {
    if (scene.start > cursor + EPS) spans.push({ start: cursor, end: Math.min(scene.start, limit) })
    cursor = Math.max(cursor, scene.end)
  }
  if (limit > cursor + EPS) spans.push({ start: cursor, end: limit })
  return spans.filter((s) => s.end - s.start >= MIN_SCENE - EPS)
}

/**
 * Where Add scene puts a new scene: from the playhead, if no scene is there, for up to
 * NEW_SCENE_SECONDS; else at the start of the first free stretch. Only within the video
 * (`videoEnd`; 0 when it has no length yet). null when there's no free time.
 */
export function addScene(scenes: readonly Scene[], playhead: number, videoEnd: number, id: string): Scene[] | null {
  const sorted = sortScenes(scenes)
  const spans = freeSpans(sorted, videoEnd > 0 ? videoEnd : Infinity)
  const here = spans.find((s) => playhead >= s.start - EPS && playhead <= s.end - MIN_SCENE + EPS)
  const span = here ?? spans[0]
  if (!span) return null
  const start = here ? Math.max(playhead, span.start) : span.start
  return sortScenes([...sorted, newScene(id, start, Math.min(span.end, start + NEW_SCENE_SECONDS))])
}

export const deleteScene = (scenes: readonly Scene[], id: string) => scenes.filter((s) => s.id !== id)

/** Previews of one scene, oldest first. */
export const previewsOf = (previews: readonly ScenePreview[], sceneId: string) => previews.filter((p) => p.sceneId === sceneId)

/** Previews whose scene is gone (deleted, merged away, or replaced by Create scenes). */
export function orphanPreviews(previews: readonly ScenePreview[], scenes: readonly Scene[]): ScenePreview[] {
  const ids = new Set(scenes.map((s) => s.id))
  return previews.filter((p) => !ids.has(p.sceneId))
}

// Loading ----------------------------------------------------------------------------------------

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const idOrNull = (value: unknown) => (typeof value === 'string' && value ? value : null)

const SOURCES: readonly SceneSource[] = ['ai', 'stock', 'none']
const STATUSES: readonly PreviewStatus[] = ['queued', 'running', 'saving', 'done', 'error', 'cancelled']

/**
 * Scenes from a saved project: broken ones are dropped, missing fields filled in, and they're
 * put in time order. A scene overlapping the one before it starts where that one ends (or is
 * dropped if too little is left), so scenes never overlap.
 */
export function normalizeScenes(raw: unknown): Scene[] {
  const candidates = (Array.isArray(raw) ? raw : [])
    .filter(isObject)
    .filter((s) => isTime(s.start) && isTime(s.end) && s.end > s.start)
    .sort((a, b) => (a.start as number) - (b.start as number))
  const scenes: Scene[] = []
  const seen = new Set<string>()
  let lastEnd = 0
  for (const s of candidates) {
    const start = Math.max(s.start as number, lastEnd)
    const end = s.end as number
    if (end - start < MIN_SCENE - EPS) continue
    const id = typeof s.id === 'string' && s.id && !seen.has(s.id) ? s.id : newId('s')
    seen.add(id)
    const count = typeof s.previewCount === 'number' ? Math.round(s.previewCount) : DEFAULT_PREVIEWS
    scenes.push({
      ...newScene(id, start, end),
      source: SOURCES.includes(s.source as SceneSource) ? (s.source as SceneSource) : 'ai',
      description: text(s.description),
      prompt: text(s.prompt),
      searchText: text(s.searchText),
      previewCount: Math.min(MAX_PREVIEWS, Math.max(MIN_PREVIEWS, count || DEFAULT_PREVIEWS)),
      selectedPreviewId: idOrNull(s.selectedPreviewId),
      stockItemId: idOrNull(s.stockItemId),
    })
    lastEnd = end
  }
  return scenes
}

/** Previews from a saved project; ones missing their scene, job or seed are dropped. */
export function normalizePreviews(raw: unknown): ScenePreview[] {
  return (Array.isArray(raw) ? raw : []).filter(isObject).flatMap((p) => {
    if (typeof p.id !== 'string' || typeof p.sceneId !== 'string' || typeof p.jobId !== 'string' || typeof p.seed !== 'number') return []
    const duration = typeof p.duration === 'number' ? Math.round(p.duration) : MIN_SHOT_SECONDS
    return [
      {
        id: p.id,
        sceneId: p.sceneId,
        jobId: p.jobId,
        seed: p.seed,
        prompt: text(p.prompt),
        duration: Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, duration)),
        status: STATUSES.includes(p.status as PreviewStatus) ? (p.status as PreviewStatus) : 'error',
        error: typeof p.error === 'string' ? p.error : null,
        itemId: idOrNull(p.itemId),
        createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
      },
    ]
  })
}
