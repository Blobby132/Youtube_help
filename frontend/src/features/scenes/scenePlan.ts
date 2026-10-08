// "Create scenes from script": cuts the narration into scenes by rules (part C adds AI). Every
// scene is 2 to 5 seconds long, because LTX clips fall apart beyond about 5 seconds. Cuts go at
// sentence ends wherever that's possible; a sentence too long for one scene is cut at commas or
// pauses, and only if those can't do it, between other words. Sentences too short for a scene of
// their own are grouped with a neighbour. Times come from the captions' words, or else the
// script's words spread over the voiceover (or its estimated length), as Auto-fill does.
import { newId } from '../../lib/ids'
import { captionsOutOfDate } from '../../state/project/selectors'
import type { Project, Scene, TimeRange } from '../../state/project/types'
import { scriptWords, SENTENCE_END, WORDS_PER_MINUTE } from '../media/autofillPlan'
import { newScene } from './sceneOps'

export const MIN_SCENE_SECONDS = 2
export const MAX_SCENE_SECONDS = 5
/** A silence at least this long between two words is a place to cut. */
export const PAUSE_SECONDS = 0.35

/** A word that ends a clause: a comma, semicolon, colon or dash (quotes allowed after). */
const CLAUSE_END = /[,;:–—-]["'”’)\]]*$/

// How much a cut at each kind of place is worth. Sentence ends earn a lot, so every one that can
// be a cut is; the rest cost, so they're only used when a sentence needs cutting. A cut anywhere
// (mid-word) only happens when nothing else gives 2 to 5 second scenes, e.g. a long silence.
const SCORE = { sentence: 10, clause: -1, pause: -1, word: -6, anywhere: -60 } as const
/** Between two equally good plans, the one whose scenes are nearer this length. */
const TARGET_SECONDS = 3.5
const GRID_SECONDS = 0.25
const EPS = 1e-6

export interface TimedWord {
  text: string
  start: number
  end: number
}

export interface SceneTiming {
  words: TimedWord[]
  /** The end of the video: the voiceover's end (or the estimate without one). */
  end: number
  /** 'captions': the captions' word times; 'estimate': the script spread by word count. */
  source: 'captions' | 'estimate'
}

/** The narration's words with times: the captions' when they're there and up to date. */
export function sceneTiming(project: Pick<Project, 'script' | 'voiceover' | 'captions'>): SceneTiming {
  const { captions, voiceover } = project
  if (captions.words.length && !captionsOutOfDate(project)) {
    const words = captions.words.map(({ text, start, end }) => ({ text, start, end }))
    return { words, end: Math.max(voiceover?.duration ?? 0, words[words.length - 1].end), source: 'captions' }
  }
  const texts = scriptWords(project.script)
  const end = voiceover?.duration ?? (texts.length / WORDS_PER_MINUTE) * 60
  const each = texts.length ? end / texts.length : 0
  return { words: texts.map((text, i) => ({ text, start: i * each, end: (i + 1) * each })), end, source: 'estimate' }
}

/** The words in a scene's time range (by where each word's middle falls). */
export function narration(words: readonly TimedWord[], range: TimeRange): string {
  return words
    .filter((w) => {
      const middle = (w.start + w.end) / 2
      return middle >= range.start - EPS && middle < range.end - EPS
    })
    .map((w) => w.text)
    .join(' ')
}

interface Cut {
  time: number
  score: number
}

/** Every place a scene could start, with what a cut there is worth. */
function cutPlaces(words: readonly TimedWord[], end: number): Cut[] {
  const cuts: Cut[] = []
  for (let i = 0; i + 1 < words.length; i++) {
    const [word, next] = [words[i], words[i + 1]]
    const pause = next.start - word.end >= PAUSE_SECONDS - EPS
    const score: number = SENTENCE_END.test(word.text)
      ? SCORE.sentence
      : CLAUSE_END.test(word.text)
        ? SCORE.clause + (pause ? 0.5 : 0)
        : pause
          ? SCORE.pause
          : SCORE.word
    // The cut goes where the next word starts, so the picture changes with the words.
    cuts.push({ time: next.start, score })
    // In a long silence the cut could also go right after the word, a little less good.
    if (pause) cuts.push({ time: word.end, score: score - 0.25 })
  }
  for (let t = GRID_SECONDS; t < end; t += GRID_SECONDS) cuts.push({ time: t, score: SCORE.anywhere })

  const inside = cuts.filter((c) => c.time > EPS && c.time < end - EPS).sort((a, b) => a.time - b.time || b.score - a.score)
  return inside.filter((c, i) => i === 0 || c.time - inside[i - 1].time > EPS)
}

/**
 * The scenes' time ranges, from 0 to the end of the video, each 2 to 5 seconds long (a video
 * shorter than 2 seconds is one scene). The best plan by SCORE, found by dynamic programming.
 */
export function planRanges(timing: Pick<SceneTiming, 'words' | 'end'>): TimeRange[] {
  const { end } = timing
  if (end <= EPS) return []
  if (end < MIN_SCENE_SECONDS) return [{ start: 0, end }]
  const places = [{ time: 0, score: 0 }, ...cutPlaces(timing.words, end), { time: end, score: 0 }]
  const best = places.map(() => -Infinity)
  const from = places.map(() => -1)
  best[0] = 0
  for (let k = 1; k < places.length; k++) {
    for (let j = k - 1; j >= 0; j--) {
      const length = places[k].time - places[j].time
      if (length < MIN_SCENE_SECONDS - EPS) continue
      if (length > MAX_SCENE_SECONDS + EPS) break
      if (best[j] === -Infinity) continue
      const value = best[j] + places[k].score - 0.01 * Math.abs(length - TARGET_SECONDS)
      if (value > best[k]) {
        best[k] = value
        from[k] = j
      }
    }
  }
  const ranges: TimeRange[] = []
  for (let k = places.length - 1; k > 0 && from[k] >= 0; k = from[k]) {
    ranges.unshift({ start: places[from[k]].time, end: places[k].time })
  }
  if (ranges.length) return ranges
  // Can't happen with the grid of cut places, but never return nothing: equal parts.
  const parts = Math.ceil(end / MAX_SCENE_SECONDS)
  return Array.from({ length: parts }, (_, i) => ({ start: (end * i) / parts, end: (end * (i + 1)) / parts }))
}

/** New scenes for the project's narration (all AI, nothing filled in yet). */
export function planScenes(timing: SceneTiming, makeId: () => string = () => newId('s')): Scene[] {
  return planRanges(timing).map((range) => newScene(makeId(), range.start, range.end))
}
