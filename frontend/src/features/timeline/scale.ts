// Timeline zoom and ruler maths.

/** Pixels between the left edge of the lanes and t = 0, so the playhead at 0 is not clipped. */
export const TIMELINE_ORIGIN_PX = 12

const MIN_PX_PER_SECOND = 6
const MAX_PX_PER_SECOND = 240

/** Zoom slider value (0..1) to pixels per second, on an exponential curve. */
export function pixelsPerSecond(zoom: number): number {
  return MIN_PX_PER_SECOND * (MAX_PX_PER_SECOND / MIN_PX_PER_SECOND) ** zoom
}

// [labelled step, minor tick step] in seconds
const STEPS: [number, number][] = [
  [0.25, 0.05],
  [0.5, 0.1],
  [1, 0.2],
  [2, 0.5],
  [5, 1],
  [10, 2],
  [15, 5],
  [30, 5],
  [60, 10],
  [120, 30],
]

/** Picks ruler steps so labels are at least `minLabelGap` pixels apart. */
export function rulerSteps(pxPerSecond: number, minLabelGap = 64): { major: number; minor: number } {
  const found = STEPS.find(([major]) => major * pxPerSecond >= minLabelGap) ?? STEPS[STEPS.length - 1]
  return { major: found[0], minor: found[1] }
}

/** Ruler label: "0:05", or "0:01.5" when the step is under a second. */
export function rulerLabel(seconds: number, majorStep: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  if (majorStep >= 1) return `${m}:${String(Math.round(s)).padStart(2, '0')}`
  const whole = Math.floor(s + 1e-6)
  const fraction = Math.round((s - whole) * 100)
  const decimals = fraction % 10 === 0 ? String(fraction / 10) : String(fraction).padStart(2, '0')
  return `${m}:${String(whole).padStart(2, '0')}.${decimals}`
}
