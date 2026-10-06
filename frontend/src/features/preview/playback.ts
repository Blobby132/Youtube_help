// Preview playback clock. The voiceover drives the clock while it plays (so audio and
// playhead never drift); past its end a wall clock takes over. Music loops underneath.
import { projectDuration } from '../../state/project/selectors'
import { useProjectStore } from '../../state/project/store'
import { setUi, useUi } from '../../state/ui'

const DRIFT_TOLERANCE = 0.05

interface Track {
  element: HTMLAudioElement
  gain: GainNode | null
  url: string | null
}

function createTrack(loop = false): Track {
  const element = new Audio()
  element.preload = 'auto'
  element.loop = loop
  return { element, gain: null, url: null }
}

class Playback {
  private context: AudioContext | null = null
  private voice = createTrack()
  private music = createTrack(true)
  private voiceDuration = 0
  private volumes = { preview: 1, muted: false, voice: 1, music: 0.15 }
  private clockStart = 0
  private frame = 0

  /** Created on the first Play click: browsers only allow audio after a user gesture. */
  private ensureContext() {
    if (this.context) return this.context
    const context = new AudioContext()
    for (const track of [this.voice, this.music]) {
      track.gain = context.createGain()
      context.createMediaElementSource(track.element).connect(track.gain).connect(context.destination)
    }
    this.context = context
    this.applyVolumes()
    return context
  }

  setSources(voiceUrl: string | null, voiceDuration: number, musicUrl: string | null) {
    this.voiceDuration = voiceDuration
    for (const [track, url] of [
      [this.voice, voiceUrl],
      [this.music, musicUrl],
    ] as const) {
      if (track.url === url) continue
      track.url = url
      track.element.pause()
      if (url) track.element.src = url
      else track.element.removeAttribute('src')
      track.element.load()
    }
    if (useUi.getState().playing) this.syncTracks(useUi.getState().playhead)
  }

  setVolumes(volumes: Partial<Playback['volumes']>) {
    this.volumes = { ...this.volumes, ...volumes }
    this.applyVolumes()
  }

  private applyVolumes() {
    const master = this.volumes.muted ? 0 : this.volumes.preview
    if (this.voice.gain) this.voice.gain.gain.value = master * this.volumes.voice
    if (this.music.gain) this.music.gain.gain.value = master * this.volumes.music
  }

  private duration() {
    return projectDuration(useProjectStore.getState().project)
  }

  play() {
    const duration = this.duration()
    if (duration <= 0) return
    void this.ensureContext().resume()
    let start = useUi.getState().playhead
    if (start >= duration - 0.01) start = 0
    this.clockStart = performance.now() - start * 1000
    setUi({ playing: true, playhead: start })
    this.syncTracks(start)
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(this.tick)
  }

  pause() {
    cancelAnimationFrame(this.frame)
    this.voice.element.pause()
    this.music.element.pause()
    if (useUi.getState().playing) setUi({ playing: false })
  }

  toggle() {
    if (useUi.getState().playing) this.pause()
    else this.play()
  }

  seek(time: number) {
    const clamped = Math.min(Math.max(0, time), this.duration())
    setUi({ playhead: clamped })
    if (useUi.getState().playing) {
      this.clockStart = performance.now() - clamped * 1000
      this.syncTracks(clamped)
    }
  }

  private syncTracks(time: number) {
    const { voice, music } = this
    if (voice.url && time < this.voiceDuration) {
      voice.element.currentTime = time
      voice.element.play().catch((error: unknown) => console.warn('Voiceover playback failed:', error))
    } else {
      voice.element.pause()
    }
    if (music.url) {
      const length = music.element.duration
      music.element.currentTime = Number.isFinite(length) && length > 0 ? time % length : time
      music.element.play().catch((error: unknown) => console.warn('Music playback failed:', error))
    }
  }

  private tick = () => {
    const duration = this.duration()
    let time = (performance.now() - this.clockStart) / 1000
    const voice = this.voice.element
    if (!voice.paused && !voice.ended && voice.currentTime < this.voiceDuration) {
      // Follow the voiceover so the playhead matches what you hear.
      if (Math.abs(voice.currentTime - time) > DRIFT_TOLERANCE) {
        time = voice.currentTime
        this.clockStart = performance.now() - time * 1000
      }
    }
    if (time >= duration) {
      this.pause()
      setUi({ playhead: duration })
      return
    }
    setUi({ playhead: time })
    this.frame = requestAnimationFrame(this.tick)
  }
}

export const playback = new Playback()
