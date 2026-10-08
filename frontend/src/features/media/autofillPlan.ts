// Auto-fill: splits the script into sentences and times each one, so every sentence gets
// one clip that starts when the sentence starts.
import type { Project } from '../../state/project/types'

/** Words per minute assumed when there's no voiceover to time against (as in the script counter). */
export const WORDS_PER_MINUTE = 155
/** Sentences shorter than this share a clip with the next one, to avoid flash cuts. */
export const MIN_SEGMENT_SECONDS = 1.5
export const MAX_SEGMENTS = 80

const MARKUP = /\[([^\]]+)\]\([^)]*\)/g
const JOINERS = new Set(['-', '–', '—', '…', '...', '--'])
/** A word that ends a sentence (also used for the ranking's "sentence under the playhead"). */
export const SENTENCE_END = /[.!?…]["'”’)\]]*$/

/** The script's words the way captions count them (backend: captions/align.py script_words). */
export function scriptWords(script: string): string[] {
  const words: string[] = []
  for (const token of script.replace(MARKUP, '$1').split(/\s+/).filter(Boolean)) {
    if (JOINERS.has(token) && words.length) words[words.length - 1] += ` ${token}`
    else words.push(token)
  }
  return words
}

export interface Segment {
  text: string
  start: number
  end: number
}

/**
 * The stretches that each get one clip. Uses the captions' word times when they match the
 * script; otherwise spreads the sentences over the voiceover (or an estimate of its length)
 * by word count.
 */
export function planSegments(project: Pick<Project, 'script' | 'voiceover' | 'captions'>): Segment[] {
  const words = scriptWords(project.script)
  if (!words.length) return []
  const { captions, voiceover } = project
  const total = voiceover?.duration ?? (words.length / WORDS_PER_MINUTE) * 60
  const timed =
    voiceover !== null &&
    captions.source === 'script' &&
    captions.voiceoverFile === voiceover.file &&
    captions.words.length === words.length
  const startOf = (index: number) => (timed ? captions.words[index].start : (total * index) / words.length)

  const sentences: { text: string; first: number }[] = []
  let first = 0
  words.forEach((word, index) => {
    if (SENTENCE_END.test(word) || index === words.length - 1) {
      sentences.push({ text: words.slice(first, index + 1).join(' '), first })
      first = index + 1
    }
  })

  let segments: Segment[] = sentences.map((sentence, index) => ({
    text: sentence.text,
    start: index === 0 ? 0 : startOf(sentence.first),
    end: index + 1 < sentences.length ? startOf(sentences[index + 1].first) : total,
  }))

  // Join short sentences to their neighbour (the next one, or the previous at the end).
  const merged: Segment[] = []
  for (const segment of segments) {
    const previous = merged[merged.length - 1]
    if (previous && previous.end - previous.start < MIN_SEGMENT_SECONDS) {
      merged[merged.length - 1] = { text: `${previous.text} ${segment.text}`, start: previous.start, end: segment.end }
    } else {
      merged.push(segment)
    }
  }
  const last = merged[merged.length - 1]
  if (merged.length > 1 && last.end - last.start < MIN_SEGMENT_SECONDS) {
    const before = merged[merged.length - 2]
    merged.splice(-2, 2, { text: `${before.text} ${last.text}`, start: before.start, end: last.end })
  }
  segments = merged
  while (segments.length > MAX_SEGMENTS) {
    const pairs: Segment[] = []
    for (let i = 0; i < segments.length; i += 2) {
      const [a, b] = [segments[i], segments[i + 1]]
      pairs.push(b ? { text: `${a.text} ${b.text}`, start: a.start, end: b.end } : a)
    }
    segments = pairs
  }
  return segments
}
