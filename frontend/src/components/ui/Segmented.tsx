import styles from './Segmented.module.css'

export interface SegmentedOption<T extends string | number> {
  value: T
  label: string
  title?: string
}

interface SegmentedProps<T extends string | number> {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** 'tabs' is the larger style used at the top of side panels. */
  variant?: 'tabs' | 'choice'
  label?: string
}

/** A row of mutually exclusive buttons: panel tabs, or a compact choice control. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  variant = 'choice',
  label,
}: SegmentedProps<T>) {
  const isTabs = variant === 'tabs'
  return (
    <div
      className={`${styles.group} ${styles[variant]}`}
      role={isTabs ? 'tablist' : 'radiogroup'}
      aria-label={label}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role={isTabs ? 'tab' : 'radio'}
            aria-selected={isTabs ? active : undefined}
            aria-checked={isTabs ? undefined : active}
            title={option.title}
            className={`${styles.item} ${active ? styles.active : ''}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
