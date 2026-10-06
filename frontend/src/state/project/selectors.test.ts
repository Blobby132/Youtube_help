import { describe, expect, it } from 'vitest'
import { createProject } from './defaults'
import { captionsOutOfDate } from './selectors'

function projectWith(voiceoverFile: string | null, captionFile: string | null, words = 1) {
  const project = createProject()
  project.voiceover = voiceoverFile ? { source: 'ai', file: voiceoverFile, duration: 3 } : null
  project.captions.voiceoverFile = captionFile
  project.captions.words = Array.from({ length: words }, (_, i) => ({ id: `w${i}`, text: 'hi', start: i, end: i + 0.5 }))
  return project
}

describe('captionsOutOfDate', () => {
  it('is false while the captions belong to the current voiceover', () => {
    expect(captionsOutOfDate(projectWith('voiceover-a.wav', 'voiceover-a.wav'))).toBe(false)
  })
  it('is true once the voiceover has been regenerated', () => {
    expect(captionsOutOfDate(projectWith('voiceover-b.wav', 'voiceover-a.wav'))).toBe(true)
  })
  it('is false without captions or without a voiceover', () => {
    expect(captionsOutOfDate(projectWith('voiceover-b.wav', 'voiceover-a.wav', 0))).toBe(false)
    expect(captionsOutOfDate(projectWith(null, 'voiceover-a.wav'))).toBe(false)
  })
})
