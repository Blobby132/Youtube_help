// Fitting a clip to the 9:16 frame: scale it until it fills the frame, then crop what
// sticks out. `cropX`/`cropY` choose which part stays (0 = left/top, 0.5 = centre,
// 1 = right/bottom). The final render (Stage 6) crops with the same numbers.

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

/** Which way a clip can be panned after filling the frame: 'x' for wider than 9:16, 'y' for taller. */
export function cropAxis(width: number, height: number, frameWidth: number, frameHeight: number): 'x' | 'y' | null {
  const ratio = width / height
  const frame = frameWidth / frameHeight
  if (Math.abs(ratio - frame) < 0.005) return null
  return ratio > frame ? 'x' : 'y'
}
