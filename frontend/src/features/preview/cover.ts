// Fitting a clip to the 9:16 frame. "Fill" (the default) scales it until it fills the frame,
// then crops what sticks out: `cropX`/`cropY` choose which part stays (0 = left/top,
// 0.5 = centre, 1 = right/bottom). "Fit inside" scales it until the whole picture fits and
// centres it; the canvas background fills the rest. The final render (Stage 6) uses the same
// numbers.
import type { ClipFit } from '../../state/project/types'

export interface SourceRect {
  /** Part of the source picture that is shown, in source pixels. */
  sx: number
  sy: number
  sw: number
  sh: number
  /** Source pixels per frame pixel (> 1 means the clip is scaled down). */
  scale: number
}

export function coverRect(
  width: number,
  height: number,
  frameWidth: number,
  frameHeight: number,
  cropX: number,
  cropY: number,
): SourceRect {
  const zoom = Math.max(frameWidth / width, frameHeight / height)
  const sw = frameWidth / zoom
  const sh = frameHeight / zoom
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return { sx: (width - sw) * clamp(cropX), sy: (height - sh) * clamp(cropY), sw, sh, scale: 1 / zoom }
}

/** Where a "Fit inside" clip goes in the frame, in frame pixels. */
export interface FrameRect {
  x: number
  y: number
  width: number
  height: number
}

export function insideRect(width: number, height: number, frameWidth: number, frameHeight: number): FrameRect {
  const zoom = Math.min(frameWidth / width, frameHeight / height)
  const w = width * zoom
  const h = height * zoom
  return { x: (frameWidth - w) / 2, y: (frameHeight - h) / 2, width: w, height: h }
}

/** Which way a clip can be panned after filling the frame: 'x' for wider than 9:16, 'y' for taller. */
export function cropAxis(width: number, height: number, frameWidth: number, frameHeight: number): 'x' | 'y' | null {
  const ratio = width / height
  const frame = frameWidth / frameHeight
  if (Math.abs(ratio - frame) < 0.005) return null
  return ratio > frame ? 'x' : 'y'
}

/** The crop a timeline clip can be moved along: none when it's set to "Fit inside". */
export function clipCropAxis(
  fit: ClipFit,
  width: number,
  height: number,
  frameWidth: number,
  frameHeight: number,
): 'x' | 'y' | null {
  return fit === 'inside' ? null : cropAxis(width, height, frameWidth, frameHeight)
}
