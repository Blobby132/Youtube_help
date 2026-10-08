import { describe, expect, it } from 'vitest'
import { createProject } from '../../state/project/defaults'
import type { CaptionWord, Project } from '../../state/project/types'
import { MAX_SCENE_SECONDS, MIN_SCENE_SECONDS, narration, planRanges, planScenes, sceneTiming, type TimedWord } from './scenePlan'

/** Words spoken one after another, `seconds` each, with `gaps[i]` of silence after word i. */
function spoken(text: string, seconds = 0.3, gaps: Record<number, number> = {}, from = 0): TimedWord[] {
  let t = from
  return text.split(' ').map((word, i) => {
    const timed = { text: word, start: t, end: t + seconds }
    t += seconds + (gaps[i] ?? 0)
    return timed
  })
}

const round = (n: number) => Math.round(n * 100) / 100

function expectValidPlan(ranges: { start: number; end: number }[], end: number) {
  expect(ranges[0].start).toBe(0)
  expect(round(ranges[ranges.length - 1].end)).toBe(round(end))
  ranges.forEach((range, i) => {
    expect(range.end - range.start).toBeGreaterThanOrEqual(MIN_SCENE_SECONDS - 1e-6)
    expect(range.end - range.start).toBeLessThanOrEqual(MAX_SCENE_SECONDS + 1e-6)
    if (i > 0) expect(range.start).toBe(ranges[i - 1].end) // no gaps, no overlaps
  })
}

/** Start times of the words that begin a scene. */
const firstWords = (words: TimedWord[], ranges: { start: number }[]) =>
  ranges.slice(1).map((r) => words.find((w) => Math.abs(w.start - r.start) < 1e-6)?.text ?? `(${round(r.start)} s)`)

function withCaptions(words: TimedWord[], voiceoverEnd: number): Project {
  const project = createProject()
  project.voiceover = { source: 'ai', file: 'voiceover-1.wav', duration: voiceoverEnd }
  project.captions.words = words.map((w, i): CaptionWord => ({ id: `w${i}`, ...w }))
  project.captions.voiceoverFile = 'voiceover-1.wav'
  project.captions.source = 'script'
  project.script = words.map((w) => w.text).join(' ')
  return project
}

describe('planRanges with caption timing', () => {
  it('cuts at sentence ends when each sentence is 2 to 5 seconds long', () => {
    // Three sentences of 10 words (3 s each), with a short breath between them.
    const words = spoken(
      'One two three four five six seven eight nine ten. Eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty. Last words of the video are here at the end.',
      0.3,
      { 9: 0.2, 19: 0.2 },
    )
    const timing = sceneTiming(withCaptions(words, 10))
    expect(timing.source).toBe('captions')
    const ranges = planRanges(timing)
    expectValidPlan(ranges, 10)
    expect(firstWords(words, ranges)).toEqual(['Eleven', 'Last'])
  })

  it('groups very short sentences into one scene', () => {
    // "Wait." "Look." "Up there." are each well under 2 seconds.
    const words = spoken('Wait. Look. Up there. The sky is full of tiny lights tonight, and they keep moving fast.', 0.35, { 0: 0.3, 1: 0.3, 3: 0.3 })
    const ranges = planRanges(sceneTiming(withCaptions(words, words[words.length - 1].end + 0.2)))
    expectValidPlan(ranges, words[words.length - 1].end + 0.2)
    // The short sentences share the first scene; the next sentence is a scene of its own.
    expect(ranges.map((r) => narration(words, r))).toEqual([
      'Wait. Look. Up there.',
      'The sky is full of tiny lights tonight, and they keep moving fast.',
    ])
  })

  it('cuts a long sentence at commas', () => {
    // One 11-word-per-clause sentence of about 10 s with two commas.
    const words = spoken(
      'When the engines start up on a cold winter morning, the whole cabin hums and shakes for a moment, and then everything settles down again.',
      0.4,
    )
    const end = words[words.length - 1].end
    const ranges = planRanges(sceneTiming(withCaptions(words, end)))
    expectValidPlan(ranges, end)
    expect(firstWords(words, ranges)).toEqual(['the', 'and'])
  })

  it('cuts a long sentence at a pause when it has no commas', () => {
    const words = spoken('The old lighthouse keeper climbed every one of the stairs slowly up to the lamp room high above the sea', 0.35, { 9: 0.6 })
    const end = words[words.length - 1].end
    const ranges = planRanges(sceneTiming(withCaptions(words, end)))
    expectValidPlan(ranges, end)
    expect(firstWords(words, ranges)).toEqual(['slowly'])
  })

  it('cuts between words when a long sentence has neither commas nor pauses', () => {
    const words = spoken('Nobody really knows why the tiny hole in every single airplane window was put there at all until today', 0.45)
    const end = words[words.length - 1].end
    const ranges = planRanges(sceneTiming(withCaptions(words, end)))
    expectValidPlan(ranges, end)
    expect(ranges.length).toBe(2)
  })

  it('covers silence at the start and end, and a long silence in the middle', () => {
    const words = [...spoken('A short line here.', 0.4, {}, 1), ...spoken('And then much later another line.', 0.4, {}, 9)]
    const ranges = planRanges(sceneTiming(withCaptions(words, 13)))
    expectValidPlan(ranges, 13)
  })

  it('makes valid scenes whatever the narration', () => {
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let run = 0; run < 40; run++) {
      const words: TimedWord[] = []
      let t = random() * 0.8
      const count = 5 + Math.floor(random() * 80)
      for (let i = 0; i < count; i++) {
        const length = 0.15 + random() * 0.5
        const end = random() < 0.15 ? '.' : random() < 0.15 ? ',' : ''
        words.push({ text: `w${i}${end}`, start: t, end: t + length })
        t += length + (random() < 0.1 ? random() * 1.5 : random() * 0.1)
      }
      const end = t + random()
      expectValidPlan(planRanges({ words, end }), end)
    }
  })

  it('makes one scene of a video under 2 seconds, and none without a script', () => {
    expect(planRanges({ words: spoken('Hello there.'), end: 1.2 })).toEqual([{ start: 0, end: 1.2 }])
    expect(planRanges({ words: [], end: 0 })).toEqual([])
  })
})

describe('sceneTiming without captions', () => {
  it('spreads the script over the voiceover by word count', () => {
    const project = createProject()
    project.script = 'One two three four five six seven eight nine ten. ' + 'Eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.'
    project.voiceover = { source: 'ai', file: 'voiceover-1.wav', duration: 8 }
    const timing = sceneTiming(project)
    expect(timing.source).toBe('estimate')
    expect(timing.words[10]).toEqual({ text: 'Eleven', start: 4, end: 4.4 })
    expect(planRanges(timing)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
    ])
  })

  it('estimates the length from the script without a voiceover', () => {
    const project = createProject()
    // 31 words at 155 words a minute: 12 seconds.
    project.script = Array.from({ length: 31 }, (_, i) => `word${i}${i % 8 === 7 ? '.' : ''}`).join(' ')
    const timing = sceneTiming(project)
    expect(timing.end).toBeCloseTo(12)
    expectValidPlan(planRanges(timing), 12)
  })

  it('does not use captions that are out of date', () => {
    const project = withCaptions(spoken('Old words. From before.'), 4)
    project.voiceover = { source: 'ai', file: 'voiceover-2.wav', duration: 6 }
    project.script = 'New script that was read again.'
    const timing = sceneTiming(project)
    expect(timing.source).toBe('estimate')
    expect(timing.end).toBe(6)
  })
})

describe('planScenes and narration', () => {
  it('makes AI scenes with nothing filled in yet, and their narration is the words in their time', () => {
    const words = spoken('First sentence is right here now. Second sentence follows it closely.', 0.5)
    const project = withCaptions(words, words[words.length - 1].end)
    let n = 0
    const scenes = planScenes(sceneTiming(project), () => `s${++n}`)
    expect(scenes.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(scenes[0]).toMatchObject({
      source: 'ai',
      description: '',
      prompt: '',
      searchText: '',
      previewCount: 2,
      selectedPreviewId: null,
      stockItemId: null,
    })
    expect(scenes.map((s) => narration(words, s))).toEqual(['First sentence is right here now.', 'Second sentence follows it closely.'])
  })
})
