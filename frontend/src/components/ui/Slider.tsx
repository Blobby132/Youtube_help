import type { CSSProperties } from 'react'
import { useId } from 'react'
import styles from './Slider.module.css'

interface RangeProps {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  disabled?: boolean
  label?: string
  className?: string
  id?: string
}

/** A styled range input whose filled part uses the accent color. */
export function Range({ value, min, max, step = 0.01, onChange, disabled, label, className, id }: RangeProps) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      id={id}
      type="range"
      className={`${styles.range} ${className ?? ''}`}
      style={{ '--fill': `${Math.min(100, Math.max(0, fill))}%` } as CSSProperties}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  )
}

interface SliderProps extends Omit<RangeProps, 'label' | 'id'> {
  label: string
  format?: (value: number) => string
}

/** Label + value readout + range. */
export function Slider({ label, format = String, ...range }: SliderProps) {
  const id = useId()
  return (
    <div className={styles.slider}>
      <div className={styles.row}>
        <label htmlFor={id}>{label}</label>
        <span className={styles.value}>{format(range.value)}</span>
      </div>
      <Range id={id} {...range} />
    </div>
  )
}
