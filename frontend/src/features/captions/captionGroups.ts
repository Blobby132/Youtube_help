// How timed words become on-screen captions. Kept free of React and canvas code so the
// final render (which draws its text with the preview code) follows exactly the same rules.
import type { CaptionWord } from '../../state/project/types'

export interface CaptionGroup {
  words: CaptionWord[]
  /** When the caption appears and disappears (seconds). */
  start: number
  end: number
}

/** A pause longer than this starts a new caption and lets the previous one disappear. */
export const MAX_GAP = 0.6
/** How long the last caption before a pause stays up after its last word. */
export const HOLD = 0.25

const SENTENCE_END = /[.!?…]["'”’)\]]*$/
const CLAUSE_END = /[,;:—–]["'”’)\]]*$/

/**
 * Splits words into captions of at most `perCaption` words. A caption also ends after a
 * sentence, after a comma once it has two or more words, and before a long pause.
 */
export function groupCaptions(words: CaptionWord[], perCaption: number): CaptionGroup[] {
  const groups: CaptionGroup[] = []
  let current: CaptionWord[] = []
  const flush = () => {
    if (current.length) groups.push({ words: current, start: current[0].start, end: current[current.length - 1].end })
    current = []
  }
  for (const word of words) {
    const previous = current[current.length - 1]
    if (
      previous &&
      (current.length >= perCaption ||
        word.start - previous.end > MAX_GAP ||
        SENTENCE_END.test(previous.text) ||
        (current.length >= 2 && CLAUSE_END.test(previous.text)))
    ) {
      flush()
    }
    current.push(word)
  }
  flush()

  // Each caption stays up until the next one starts, unless there's a long pause between.
  for (let i = 0; i < groups.length; i++) {
    const lastWordEnd = groups[i].end
    const next = groups[i + 1]
    groups[i].end = next && next.start - lastWordEnd <= MAX_GAP ? next.start : lastWordEnd + HOLD
  }
  return groups
}

/** Index of the caption showing at `time` (-1 for none), by binary search. */
export function groupIndexAt(groups: CaptionGroup[], time: number): number {
  let low = 0
  let high = groups.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const group = groups[mid]
    if (time < group.start) high = mid - 1
    else if (time >= group.end) low = mid + 1
    else return mid
  }
  return -1
}

/** The caption showing at `time`. */
export function groupAt(groups: CaptionGroup[], time: number): CaptionGroup | null {
  return groups[groupIndexAt(groups, time)] ?? null
}

/** Index of the word being spoken: the last one that has started. */
export function activeWordIndex(group: CaptionGroup, time: number): number {
  let index = 0
  for (let i = 0; i < group.words.length; i++) if (group.words[i].start <= time) index = i
  return index
}

/** On-screen text of a word: trailing periods and commas dropped, ? and ! kept. */
export function displayWord(text: string, uppercase: boolean): string {
  const trimmed = text.replace(/[.,;:]+(["'”’)\]]*)$/, '$1') || text
  return uppercase ? trimmed.toUpperCase() : trimmed
}

/**
 * Replaces a caption's words with edited text. Same word count: only the spelling changes.
 * Otherwise the caption's time span is shared out by word length. Empty text removes it.
 */
export function editGroupText(
  words: CaptionWord[],
  group: CaptionGroup,
  text: string,
  newId: () => string,
): CaptionWord[] {
  const first = words.indexOf(group.words[0])
  if (first < 0) return words
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  const old = group.words
  let replacement: CaptionWord[]
  if (tokens.length === old.length) {
    replacement = old.map((word, i) => (word.text === tokens[i] ? word : { ...word, text: tokens[i] }))
  } else {
    const start = old[0].start
    const span = old[old.length - 1].end - start
    const weights = tokens.map((token) => Math.max(1, token.length))
    const total = weights.reduce((a, b) => a + b, 0)
    let cursor = start
    replacement = tokens.map((token, i) => {
      const length = (span * weights[i]) / total
      const word = { id: newId(), text: token, start: round(cursor), end: round(cursor + length) }
      cursor += length
      return word
    })
  }
  return [...words.slice(0, first), ...replacement, ...words.slice(first + old.length)]
}

const round = (value: number) => Math.round(value * 1000) / 1000
