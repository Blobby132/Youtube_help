import type { ReactNode } from 'react'
import styles from './Section.module.css'

interface SectionProps {
  label: string
  hint?: ReactNode
  /** Rendered on the right of the label, e.g. an "On" toggle. */
  action?: ReactNode
  children?: ReactNode
}

/** A titled block inside a side panel: SMALL MONO LABEL, grey helper text, content. */
export function Section({ label, hint, action, children }: SectionProps) {
  return (
    <section className={styles.section}>
      <header className={styles.header}>
        <h3 className={styles.label}>{label}</h3>
        {action}
      </header>
      {hint && <p className={styles.hint}>{hint}</p>}
      {children && <div className={styles.body}>{children}</div>}
    </section>
  )
}

/** Small uppercase label for groups inside a section. */
export function SubLabel({ children }: { children: ReactNode }) {
  return <h4 className={styles.subLabel}>{children}</h4>
}
