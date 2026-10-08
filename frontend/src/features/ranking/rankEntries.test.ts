import { describe, expect, it } from 'vitest'
import type { Ranking, TimelineClip } from '../../state/project/types'
import { newClip } from '../timeline/clipOps'
import { clipForNewEntry, moveEntry, orderLabel, rankAt, rankNumber, rankSpans } from './rankEntries'

const clip = (id: string, start: number, duration: number): TimelineClip => newClip(id, `m-${id}`, start, duration)

// Three clips back to back: a 0-2, b 2-5, c 5-7.
const clips = [clip('a', 0, 2), clip('b', 2, 3), clip('c', 5, 2)]

function ranking(links: (string | null)[], patch: Partial<Ranking> = {}): Ranking {
  return {
    enabled: true,
    direction: 'down',
    entries: links.map((clipId, i) => ({ id: `r${i}`, label: `Item ${i}`, clipId })),
    style: { fontId: 'anton', size: 200, numberColor: '#ffd60a', labelColor: '#ffffff' },
    ...patch,
  }
}

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
  it('gives each entry its rank and clip', () => {
    const spans = rankSpans(ranking(['a', 'b', 'c']), clips)
    expect(spans.map((s) => [s.rank, s.clip?.id, s.problem])).toEqual([
      [3, 'a', null],
      [2, 'b', null],
      [1, 'c', null],
    ])
  })

  it('says when an entry has no clip, or its clip was removed', () => {
    const spans = rankSpans(ranking([null, 'gone']), clips)
    expect(spans.map((s) => s.problem)).toEqual(['no-clip', 'clip-removed'])
    expect(spans[1].clip).toBeNull()
  })

  it('flags an entry whose clip plays before the one above it', () => {
    const spans = rankSpans(ranking(['b', 'a', 'c']), clips)
    expect(spans.map((s) => s.problem)).toEqual([null, 'out-of-order', null])
    expect(spans[1].before).toBe(3)
  })
})

describe('rankAt', () => {
  it('shows the entry whose clip is playing', () => {
    const r = ranking(['a', null, 'c'])
    expect(rankAt(r, clips, 1)).toMatchObject({ rank: 3, entry: { id: 'r0' } })
    expect(rankAt(r, clips, 6.5)).toMatchObject({ rank: 1, entry: { id: 'r2' } })
  })

  it('shows nothing over unlinked clips, in gaps, or when the ranking is off', () => {
    const r = ranking(['a', null, 'c'])
    expect(rankAt(r, clips, 3)).toBeNull()
    expect(rankAt(r, clips, 8)).toBeNull()
    expect(rankAt({ ...r, enabled: false }, clips, 1)).toBeNull()
  })

  it('stops showing once its clip is deleted, and comes back when it is restored', () => {
    const r = ranking(['b'])
    expect(rankAt(r, clips.filter((c) => c.id !== 'b'), 3)).toBeNull()
    expect(rankAt(r, clips, 3)).toMatchObject({ rank: 1 })
  })
})

describe('clipForNewEntry', () => {
  it('uses the selected clip, else the one under the playhead', () => {
    expect(clipForNewEntry(clips, [], 'b', 0)).toBe('b')
    expect(clipForNewEntry(clips, [], null, 6)).toBe('c')
  })

  it('never links a clip twice; falls back to the next free clip after the linked ones', () => {
    const entries = ranking(['a']).entries
    expect(clipForNewEntry(clips, entries, 'a', 1)).toBe('b')
    expect(clipForNewEntry(clips, ranking(['a', 'b', 'c']).entries, null, 0)).toBeNull()
  })

  it('links nothing without clips', () => {
    expect(clipForNewEntry([], [], null, 0)).toBeNull()
  })
})

describe('moveEntry', () => {
  it('moves an entry, shifting the ones in between', () => {
    expect(moveEntry(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveEntry(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveEntry(['a', 'b'], 1, 5)).toEqual(['a', 'b'])
  })
})
