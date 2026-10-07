import { describe, expect, it } from 'vitest'
import { createProject } from '../../state/project/defaults'
import { MIN_SEGMENT_SECONDS, planSegments, scriptWords } from './autofillPlan'

const SCRIPT =
  'Every airplane window has a tiny hole in it. And it is not a mistake. ' +
  'It is called a breather hole, and it keeps the window from fogging up.'

function project(script: string, voiceover: number | null, captions?: { words: string[]; step: number }) {
  const p = createProject()
  p.script = script
  if (voiceover !== null) p.voiceover = { source: 'ai', file: 'voiceover-1.wav', duration: voiceover }
  if (captions) {
    p.captions.words = captions.words.map((text, i) => ({ id: `w${i}`, text, start: 0.3 + i * captions.step, end: 0.3 + i * captions.step + 0.2 }))
    p.captions.source = 'script'
    p.captions.voiceoverFile = 'voiceover-1.wav'
  }
  return p
}

describe('auto-fill plan', () => {
  it('counts words like the captions do', () => {
    expect(scriptWords('Wait — what? [Kokoro](/kˈOkəɹO/) talks.')).toEqual(['Wait —', 'what?', 'Kokoro', 'talks.'])
  })

  it('gives each sentence a stretch from its first word to the next sentence', () => {
    const words = scriptWords(SCRIPT)
    const segments = planSegments(project(SCRIPT, 12, { words, step: 0.4 }))
    expect(segments.map((s) => s.text)).toEqual([
      'Every airplane window has a tiny hole in it.',
      'And it is not a mistake.',
      'It is called a breather hole, and it keeps the window from fogging up.',
    ])
    // Sentence 2 starts at word 9, sentence 3 at word 15 (0.3 + index × 0.4).
    expect(segments.map((s) => [s.start, s.end].map((t) => +t.toFixed(2)))).toEqual([
      [0, 3.9],
      [3.9, 6.3],
      [6.3, 12],
    ])
  })

  it('spreads sentences by word count without matching captions', () => {
    const segments = planSegments(project(SCRIPT, 29, undefined))
    const words = scriptWords(SCRIPT).length // 29
    expect(segments[1].start).toBeCloseTo((29 * 9) / words)
    expect(segments[2].end).toBe(29)
  })

  it('estimates the length from the script without a voiceover', () => {
    const segments = planSegments(project(SCRIPT, null))
    expect(segments[segments.length - 1].end).toBeCloseTo((scriptWords(SCRIPT).length / 155) * 60)
  })

  it('joins short sentences to their neighbour', () => {
    const segments = planSegments(project('Wow. Lions sleep up to twenty hours a day, every single day. Really.', 6))
    expect(segments.map((s) => s.text)).toEqual(['Wow. Lions sleep up to twenty hours a day, every single day. Really.'])
    // 21 words over 21 s: "Wow." and "Really." last a second each.
    const script = 'Wow. Lions sleep up to twenty hours a day, every single day. Really. Cats are lazy too, sleeping most afternoons away.'
    const longer = planSegments(project(script, 21))
    expect(longer.map((s) => s.text)).toEqual([
      'Wow. Lions sleep up to twenty hours a day, every single day.',
      'Really. Cats are lazy too, sleeping most afternoons away.',
    ])
    expect(longer.every((s) => s.end - s.start >= MIN_SEGMENT_SECONDS)).toBe(true)
  })
})
