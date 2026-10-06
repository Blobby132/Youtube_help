import { describe, expect, it } from 'vitest'
import type { CaptionWord } from '../../state/project/types'
import { activeWordIndex, displayWord, editGroupText, groupAt, groupCaptions, HOLD } from './captionGroups'

let counter = 0
const w = (text: string, start: number, end: number): CaptionWord => ({ id: `w${counter++}`, text, start, end })

const sentence = [
  w('Every', 0.4, 0.6),
  w('airplane', 0.6, 1.0),
  w('window', 1.0, 1.4),
  w('has', 1.4, 1.6),
  w('a', 1.6, 1.7),
  w('hole.', 1.7, 2.0),
  w('Really!', 2.3, 2.8),
]

describe('groupCaptions', () => {
  it('shows one word at a time, each until the next starts', () => {
    const groups = groupCaptions(sentence, 1)
    expect(groups).toHaveLength(7)
    expect(groups[0]).toMatchObject({ start: 0.4, end: 0.6 })
    expect(groups[5]).toMatchObject({ start: 1.7, end: 2.3 })
    expect(groups[6].end).toBeCloseTo(2.8 + HOLD)
  })

  it('packs up to N words but never across a sentence end', () => {
    const groups = groupCaptions(sentence, 4)
    expect(groups.map((g) => g.words.map((x) => x.text).join(' '))).toEqual([
      'Every airplane window has',
      'a hole.',
      'Really!',
    ])
  })

  it('breaks after a comma once a caption has two words', () => {
    const words = [w('So,', 0, 0.2), w('look', 0.2, 0.4), w('closely,', 0.4, 0.8), w('friends', 0.8, 1.2)]
    expect(groupCaptions(words, 4).map((g) => g.words.length)).toEqual([3, 1])
  })

  it('starts a new caption after a long pause and lets the old one go', () => {
    const words = [w('Wait', 0, 0.3), w('for', 0.3, 0.5), w('it', 2.0, 2.2)]
    const groups = groupCaptions(words, 3)
    expect(groups).toHaveLength(2)
    expect(groups[0].end).toBeCloseTo(0.5 + HOLD)
  })
})

describe('groupAt and activeWordIndex', () => {
  const groups = groupCaptions(sentence, 3)
  it('finds the caption on screen', () => {
    expect(groupAt(groups, 0.1)).toBeNull()
    expect(groupAt(groups, 0.5)?.words[0].text).toBe('Every')
    expect(groupAt(groups, 1.65)?.words[0].text).toBe('has')
    expect(groupAt(groups, 10)).toBeNull()
  })
  it('highlights the word being spoken', () => {
    expect(activeWordIndex(groups[0], 0.45)).toBe(0)
    expect(activeWordIndex(groups[0], 1.1)).toBe(2)
  })
})

describe('displayWord', () => {
  it('drops trailing periods and commas but keeps ? and !', () => {
    expect(displayWord('hole.', false)).toBe('hole')
    expect(displayWord('so,', true)).toBe('SO')
    expect(displayWord('Really!', false)).toBe('Really!')
    expect(displayWord('why?', false)).toBe('why?')
    expect(displayWord('9.5', false)).toBe('9.5')
  })
})

describe('editGroupText', () => {
  const words = [w('Evry', 0, 0.5), w('window', 0.5, 1.0), w('next', 1.2, 1.5)]
  const group = groupCaptions(words, 2)[0]
  it('fixes spelling and keeps timing', () => {
    const edited = editGroupText(words, group, 'Every window', () => 'new')
    expect(edited.map((x) => [x.text, x.start, x.end])).toEqual([
      ['Every', 0, 0.5],
      ['window', 0.5, 1.0],
      ['next', 1.2, 1.5],
    ])
    expect(edited[1]).toBe(words[1])
  })
  it('re-times when the word count changes', () => {
    const edited = editGroupText(words, group, 'Every single window', () => `n${counter++}`)
    expect(edited.map((x) => x.text)).toEqual(['Every', 'single', 'window', 'next'])
    expect(edited[0].start).toBe(0)
    expect(edited[2].end).toBe(1)
  })
  it('removes the caption when emptied', () => {
    expect(editGroupText(words, group, '  ', () => 'x').map((x) => x.text)).toEqual(['next'])
  })
})
