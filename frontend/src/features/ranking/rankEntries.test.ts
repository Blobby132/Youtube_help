import { describe, expect, it } from 'vitest'
import type { CaptionWord, RankEntry, Ranking, TimeRange, TimelineClip } from '../../state/project/types'
import { newClip } from '../timeline/clipOps'
import {
  fitRange,
  MIN_RANK,
  moveEntry,
  orderLabel,
  rangeForNewEntry,
  rankAt,
  rankNumber,
  rankSpans,
  resizeEntry,
  sentenceAt,
  sentences,
  timesFromClipLinks,
} from './rankEntries'

const clip = (id: string, start: number, duration: number): TimelineClip => newClip(id, `m-${id}`, start, duration)

// Three clips back to back: a 0-2, b 2-5, c 5-7.
const clips = [clip('a', 0, 2), clip('b', 2, 3), clip('c', 5, 2)]

const entries = (times: (TimeRange | null)[]): RankEntry[] => times.map((time, i) => ({ id: `r${i}`, label: `Item ${i}`, time }))

function ranking(times: (TimeRange | null)[], patch: Partial<Ranking> = {}): Ranking {
  return {
    enabled: true,
    direction: 'down',
    entries: entries(times),
    style: { fontId: 'anton', size: 200, numberColor: '#ffd60a', labelColor: '#ffffff' },
    ...patch,
  }
}

const words = (spec: string): CaptionWord[] =>
  spec.split(' ').map((text, i) => ({ id: `w${i}`, text, start: i * 0.5, end: i * 0.5 + 0.4 }))

// "Every plane flies. Birds do too!" at 0.5 s per word: 0-1.4 and 1.5-2.9.
const twoSentences = words('Every plane flies. Birds do too!')

const times = (list: readonly RankEntry[]) => list.map((e) => e.time && [e.time.start, e.time.end])

describe('rank numbers', () => {
  it('counts down from the number of entries, or up from 1', () => {
    expect([0, 1, 2].map((i) => rankNumber(i, 3, 'down'))).toEqual([3, 2, 1])
    expect([0, 1, 2].map((i) => rankNumber(i, 3, 'up'))).toEqual([1, 2, 3])
  })

  it('labels the order with the real count once there are two entries', () => {
    expect(orderLabel('down', 0)).toBe('Count down 5→1')
    expect(orderLabel('down', 4)).toBe('Count down 4→1')
    expect(orderLabel('up', 3)).toBe('Count up 1→3')
  })
})

describe('rankSpans', () => {
  it('gives each entry its rank', () => {
    const spans = rankSpans(ranking([{ start: 0, end: 2 }, { start: 2, end: 5 }, { start: 5, end: 7 }]))
    expect(spans.map((s) => [s.rank, s.problem])).toEqual([
      [3, null],
      [2, null],
      [1, null],
    ])
  })

  it('says when an entry has no time yet', () => {
    expect(rankSpans(ranking([null, { start: 1, end: 2 }])).map((s) => s.problem)).toEqual(['no-time', null])
  })

  it('flags an entry that starts before the one above it', () => {
    const spans = rankSpans(ranking([{ start: 2, end: 5 }, { start: 0, end: 2 }, { start: 5, end: 7 }]))
    expect(spans.map((s) => s.problem)).toEqual([null, 'out-of-order', null])
    expect(spans[1].before).toBe(3)
  })
})

describe('rankAt', () => {
  const r = ranking([{ start: 0.5, end: 2 }, null, { start: 5, end: 6.5 }])

  it('shows the entry whose time it is', () => {
    expect(rankAt(r, 1)).toMatchObject({ rank: 3, entry: { id: 'r0' } })
    expect(rankAt(r, 6)).toMatchObject({ rank: 1, entry: { id: 'r2' } })
  })

  it('shows nothing outside the entries, at an end, or when the ranking is off', () => {
    expect(rankAt(r, 0.2)).toBeNull()
    expect(rankAt(r, 2)).toBeNull()
    expect(rankAt(r, 3)).toBeNull()
    expect(rankAt({ ...r, enabled: false }, 1)).toBeNull()
  })
})

describe('sentences', () => {
  it('splits caption words at sentence ends', () => {
    expect(sentences(twoSentences)).toEqual([
      { start: 0, end: 1.4 },
      { start: 1.5, end: 2.9 },
    ])
    expect(sentences(words('No ending here'))).toEqual([{ start: 0, end: 1.4 }])
    expect(sentences(words('He said “stop.” Then left'))).toEqual([
      { start: 0, end: 1.4 },
      { start: 1.5, end: 2.4 },
    ])
  })

  it('finds the sentence under the playhead, none in the pause between', () => {
    expect(sentenceAt(twoSentences, 2)).toEqual({ start: 1.5, end: 2.9 })
    expect(sentenceAt(twoSentences, 1.45)).toBeNull()
    expect(sentenceAt([], 1)).toBeNull()
  })
})

describe('fitRange', () => {
  const taken = entries([{ start: 1, end: 2 }, { start: 3, end: 4 }])

  it('keeps a free range as it is', () => {
    expect(fitRange(taken, { start: 4, end: 6 })).toEqual({ start: 4, end: 6 })
  })

  it('trims to the longest free part, so entries never overlap', () => {
    expect(fitRange(taken, { start: 0.5, end: 3.5 })).toEqual({ start: 2, end: 3 })
    expect(fitRange(taken, { start: 1.5, end: 5.5 })).toEqual({ start: 4, end: 5.5 })
  })

  it('gives nothing when the free part is too short, but ignores the entry being re-timed', () => {
    expect(fitRange(taken, { start: 1, end: 2 })).toBeNull()
    expect(fitRange(taken, { start: 1.95, end: 2.05 + MIN_RANK / 2 })).toBeNull()
    expect(fitRange(taken, { start: 1, end: 2 }, 'r0')).toEqual({ start: 1, end: 2 })
  })
})

describe('rangeForNewEntry', () => {
  const base = { entries: [] as RankEntry[], clips, words: twoSentences, selectedClipId: null, playhead: 0 }

  it('uses the selected clip’s span', () => {
    expect(rangeForNewEntry({ ...base, selectedClipId: 'b', playhead: 0.2 })).toEqual({ start: 2, end: 5 })
  })

  it('else the sentence under the playhead', () => {
    expect(rangeForNewEntry({ ...base, playhead: 2 })).toEqual({ start: 1.5, end: 2.9 })
  })

  it('else a few seconds from the playhead, or after the last entry when that’s taken', () => {
    expect(rangeForNewEntry({ ...base, words: [], playhead: 4 })).toEqual({ start: 4, end: 7 })
    const taken = entries([{ start: 0, end: 6 }])
    expect(rangeForNewEntry({ ...base, entries: taken, words: [], playhead: 1 })).toEqual({ start: 6, end: 9 })
  })

  it('never overlaps another entry', () => {
    const taken = entries([{ start: 2, end: 3 }])
    expect(rangeForNewEntry({ ...base, entries: taken, selectedClipId: 'b' })).toEqual({ start: 3, end: 5 })
    // The selected clip is fully used: falls back to the sentence under the playhead.
    const full = entries([{ start: 2, end: 5 }])
    expect(rangeForNewEntry({ ...base, entries: full, selectedClipId: 'b', playhead: 0.5 })).toEqual({ start: 0, end: 1.4 })
  })
})

describe('resizeEntry', () => {
  const list = entries([{ start: 1, end: 2 }, { start: 3, end: 4 }, null])

  it('moves one edge and keeps the other', () => {
    expect(times(resizeEntry(list, 'r0', 'end', 2.5))).toEqual([[1, 2.5], [3, 4], null])
    expect(times(resizeEntry(list, 'r1', 'start', 2.4))).toEqual([[1, 2], [2.4, 4], null])
  })

  it('stops at the neighbouring entries and at 0', () => {
    expect(times(resizeEntry(list, 'r0', 'end', 3.6))[0]).toEqual([1, 3])
    expect(times(resizeEntry(list, 'r1', 'start', 0.5))[1]).toEqual([2, 4])
    expect(times(resizeEntry(list, 'r0', 'start', -1))[0]).toEqual([0, 2])
    expect(times(resizeEntry(list, 'r1', 'end', 99))[1]).toEqual([3, 99])
  })

  it('keeps an entry at least MIN_RANK long', () => {
    expect(times(resizeEntry(list, 'r0', 'end', 0))[0]).toEqual([1, 1 + MIN_RANK])
    expect(times(resizeEntry(list, 'r0', 'start', 5))[0]).toEqual([2 - MIN_RANK, 2])
  })

  it('leaves entries without a time alone', () => {
    expect(resizeEntry(list, 'r2', 'end', 5)).toEqual(list)
  })
})

describe('timesFromClipLinks', () => {
  it('turns each linked clip into its span', () => {
    expect(timesFromClipLinks(['a', 'c', null, 'gone'], clips)).toEqual([{ start: 0, end: 2 }, { start: 5, end: 7 }, null, null])
  })

  it('gives a second link to the same clip no time, so entries never overlap', () => {
    expect(timesFromClipLinks(['b', 'b'], clips)).toEqual([{ start: 2, end: 5 }, null])
  })
})

describe('moveEntry', () => {
  it('moves an entry, shifting the ones in between', () => {
    expect(moveEntry(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveEntry(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveEntry(['a', 'b'], 1, 5)).toEqual(['a', 'b'])
  })
})
