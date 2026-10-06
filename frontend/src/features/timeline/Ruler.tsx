import type { CSSProperties } from 'react'
import { TIMELINE_ORIGIN_PX, rulerLabel, rulerSteps } from './scale'
import styles from './Timeline.module.css'

interface RulerProps {
  pxPerSecond: number
  length: number
}

/** Time ruler. Minor ticks are a repeating gradient; only labelled ticks are DOM nodes. */
export function Ruler({ pxPerSecond, length }: RulerProps) {
  const { major, minor } = rulerSteps(pxPerSecond)
  const labels: number[] = []
  for (let i = 0; i * major <= length + 1e-6; i++) labels.push(Number((i * major).toFixed(3)))

  return (
    <div
      className={styles.ruler}
      style={{ '--minor': `${minor * pxPerSecond}px`, '--origin': `${TIMELINE_ORIGIN_PX}px` } as CSSProperties}
      aria-hidden
    >
      {labels.map((t) => (
        <span key={t} className={styles.tick} style={{ left: TIMELINE_ORIGIN_PX + t * pxPerSecond }}>
          {rulerLabel(t, major)}
        </span>
      ))}
    </div>
  )
}
