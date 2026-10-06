import styles from './ProgressBar.module.css'

interface ProgressBarProps {
  /** 0..1 */
  value: number
  label?: string
}

export function ProgressBar({ value, label }: ProgressBarProps) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div className={styles.track} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={styles.fill} style={{ width: `${percent}%` }} />
    </div>
  )
}
