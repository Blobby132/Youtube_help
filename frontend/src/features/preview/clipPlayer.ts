// Plays the video track in the preview. Each clip near the playhead gets its own <video>
// element: the current one plays in step with the playback clock (the voiceover), and the
// next one waits on its first frame so cuts are instant. Clip audio is muted unless the
// clip keeps it.
import { libraryFileUrl, libraryThumbnailUrl, type LibraryItem } from '../../lib/api'
import type { TimelineClip } from '../../state/project/types'
import { clipAt } from '../timeline/clipOps'

/** Re-sync a playing clip when it drifts this far from the clock (seconds). */
const DRIFT = 0.2
/** Start loading the next clip this long before its cut. */
const LOOKAHEAD = 2.5
const MAX_ELEMENTS = 8

export interface ClipFrame {
  source: CanvasImageSource
  width: number
  height: number
  clip: TimelineClip
  item: LibraryItem
}

interface Slot {
  element: HTMLVideoElement
  mediaId: string
  usedAt: number
  /** True once a frame has been decoded (after a seek, or while playing). Until then a
   * paused <video> that isn't in the page can draw as nothing, so its thumbnail is shown. */
  hasFrame: boolean
  /** The first seek that makes the browser decode a frame has been asked for. */
  primed: boolean
}

class ClipPlayer {
  private slots = new Map<string, Slot>()
  private images = new Map<string, HTMLImageElement>()
  private listeners = new Set<() => void>()
  private volume = { preview: 1, muted: false }

  /** Called when a new frame is ready to draw (a seek finished, an image loaded, ...). */
  onFrame(listener: () => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private notify = () => this.listeners.forEach((listener) => listener())

  setVolume(preview: number, muted: boolean) {
    this.volume = { preview, muted }
  }

  private slot(clip: TimelineClip): Slot {
    const existing = this.slots.get(clip.id)
    if (existing && existing.mediaId === clip.mediaId) {
      existing.usedAt = performance.now()
      return existing
    }
    if (existing) this.drop(clip.id)
    const element = document.createElement('video')
    element.preload = 'auto'
    element.muted = true
    element.playsInline = true
    const slot: Slot = { element, mediaId: clip.mediaId, usedAt: performance.now(), hasFrame: false, primed: false }
    const decoded = () => {
      slot.hasFrame = true
      this.notify()
    }
    element.addEventListener('seeked', decoded)
    element.addEventListener('timeupdate', () => {
      if (!element.paused) decoded()
    })
    // Metadata arriving lets sync() ask for the first frame.
    element.addEventListener('loadedmetadata', this.notify)
    element.src = libraryFileUrl(clip.mediaId)
    this.slots.set(clip.id, slot)
    this.evict()
    return slot
  }

  private image(item: LibraryItem, thumbnail = false): HTMLImageElement {
    const key = `${item.id}${thumbnail ? ':thumb' : ''}`
    let image = this.images.get(key)
    if (!image) {
      image = new Image()
      image.decoding = 'async'
      image.addEventListener('load', this.notify)
      image.src = thumbnail ? libraryThumbnailUrl(item.id) : libraryFileUrl(item.id)
      this.images.set(key, image)
    }
    return image
  }

  private drop(clipId: string) {
    const slot = this.slots.get(clipId)
    if (!slot) return
    slot.element.pause()
    slot.element.removeAttribute('src')
    slot.element.load()
    this.slots.delete(clipId)
  }

  private evict() {
    if (this.slots.size <= MAX_ELEMENTS) return
    const oldest = [...this.slots.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [id] of oldest.slice(0, this.slots.size - MAX_ELEMENTS)) this.drop(id)
  }

  /** Brings the clip elements in line with the clock. Cheap enough to call every frame. */
  sync(time: number, playing: boolean, clips: readonly TimelineClip[], items: ReadonlyMap<string, LibraryItem>) {
    const active = clipAt(clips, time)
    const upcoming = clips
      .filter((c) => c.start > time && c.start - time < LOOKAHEAD && c.id !== active?.id)
      .sort((a, b) => a.start - b.start)[0]
    const keep = new Set<string>()

    for (const clip of [active, upcoming]) {
      if (!clip) continue
      const item = items.get(clip.mediaId)
      if (item?.kind !== 'video') continue
      keep.add(clip.id)
      const slot = this.slot(clip)
      const element = slot.element
      const isActive = clip === active
      const target = isActive ? clip.inPoint + (time - clip.start) * clip.speed : clip.inPoint
      element.playbackRate = clip.speed
      element.muted = !isActive || !clip.keepAudio || this.volume.muted
      element.volume = Math.min(1, Math.max(0, clip.volume * this.volume.preview))
      if (isActive && playing) {
        if (element.paused || element.ended) {
          element.currentTime = target
          element.play().catch((error: unknown) => {
            // Pausing before playback starts rejects play(); that's expected.
            if (!(error instanceof DOMException && error.name === 'AbortError')) console.warn('Clip playback failed:', error)
          })
        } else if (Math.abs(element.currentTime - target) > DRIFT) {
          element.currentTime = target
        }
      } else {
        if (!element.paused) element.pause()
        const needsFirstFrame = !slot.primed && element.readyState >= HTMLMediaElement.HAVE_METADATA
        if ((needsFirstFrame || Math.abs(element.currentTime - target) > 0.02) && !element.seeking) {
          // Setting currentTime always seeks (even to the same time), which decodes that frame.
          slot.primed = slot.primed || needsFirstFrame
          element.currentTime = target
        }
      }
    }
    for (const [id, slot] of this.slots) if (!keep.has(id) && !slot.element.paused) slot.element.pause()
  }

  /** What to draw at `time`: the clip's current frame (or its thumbnail while that loads). */
  frame(time: number, clips: readonly TimelineClip[], items: ReadonlyMap<string, LibraryItem>): ClipFrame | 'missing' | null {
    const clip = clipAt(clips, time)
    if (!clip) return null
    const item = items.get(clip.mediaId)
    if (!item) return 'missing'
    if (item.kind === 'image') {
      const image = this.image(item)
      return image.complete && image.naturalWidth ? { source: image, width: image.naturalWidth, height: image.naturalHeight, clip, item } : null
    }
    const slot = this.slots.get(clip.id)
    const element = slot?.element
    if (slot?.hasFrame && element && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && element.videoWidth) {
      return { source: element, width: element.videoWidth, height: element.videoHeight, clip, item }
    }
    const thumbnail = this.image(item, true)
    return thumbnail.complete && thumbnail.naturalWidth
      ? { source: thumbnail, width: thumbnail.naturalWidth, height: thumbnail.naturalHeight, clip, item }
      : null
  }

  pauseAll() {
    for (const slot of this.slots.values()) slot.element.pause()
  }

  /** Forgets every element, e.g. when another project opens. */
  reset() {
    for (const id of [...this.slots.keys()]) this.drop(id)
  }
}

export const clipPlayer = new ClipPlayer()

