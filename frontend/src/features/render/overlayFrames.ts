// The text overlays of the final render. Each frame of the video gets the overlay the preview
// would draw at that frame's time; runs of frames that look the same share one image. Every
// image is drawn by the preview's own drawFrameOverlays onto a transparent 1080x1920 canvas,
// with the same fonts, so the render can't place or wrap text differently from the preview.
import { loadFont } from '../../lib/fonts'
import type { Project } from '../../state/project/types'
import { CANVAS } from '../../state/project/types'
import {
  drawFrameOverlays,
  isEmpty,
  overlayFonts,
  overlayKey,
  overlayScene,
  type OverlayScene,
  type OverlayState,
  overlayState,
} from '../preview/frameOverlays'

export interface FrameRate {
  num: number
  den: number
}

/** Frames [first, end) that show the same overlay. */
export interface OverlayRun {
  first: number
  end: number
  state: OverlayState
  /** When to draw it: the time of its first frame. */
  time: number
}

export const frameTime = (frame: number, fps: FrameRate) => (frame * fps.den) / fps.num

/** The runs of frames that show text (frames without any are left out). */
export function overlayRuns(scene: OverlayScene, frames: number, fps: FrameRate): OverlayRun[] {
  const runs: OverlayRun[] = []
  let current: (OverlayRun & { key: string }) | null = null
  for (let frame = 0; frame < frames; frame++) {
    const time = frameTime(frame, fps)
    const state = overlayState(scene, time)
    const key = overlayKey(state)
    if (current && current.key === key) {
      current.end = frame + 1
      continue
    }
    current = { first: frame, end: frame + 1, state, time, key }
    if (!isEmpty(state)) runs.push(current)
  }
  return runs.map(({ first, end, state, time }) => ({ first, end, state, time }))
}

export interface OverlayImages {
  /** One entry per image, in order: its frames and its size in `data`. */
  manifest: { first: number; end: number; size: number }[]
  /** The PNG files, one after the other. */
  data: Blob
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not draw the text overlays'))), 'image/png'),
  )
}

/** Draws every overlay image of the video. `onProgress` gets 0..1. */
export async function drawOverlayImages(
  project: Project,
  frames: number,
  fps: FrameRate,
  onProgress: (share: number) => void,
  signal: AbortSignal,
): Promise<OverlayImages> {
  const scene = overlayScene(project)
  // The preview falls back to another font while one loads; the render waits for it.
  await Promise.all(overlayFonts(scene).map((fontId) => loadFont(fontId).catch(() => undefined)))
  const runs = overlayRuns(scene, frames, fps)

  const canvas = document.createElement('canvas')
  canvas.width = CANVAS.width
  canvas.height = CANVAS.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot draw the text overlays')

  const manifest: OverlayImages['manifest'] = []
  const images: Blob[] = []
  for (const [i, run] of runs.entries()) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    drawFrameOverlays(ctx, scene, run.state, run.time)
    const png = await toPng(canvas)
    images.push(png)
    manifest.push({ first: run.first, end: run.end, size: png.size })
    onProgress((i + 1) / runs.length)
  }
  return { manifest, data: new Blob(images, { type: 'application/octet-stream' }) }
}
