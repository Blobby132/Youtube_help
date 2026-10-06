import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import styles from './InlineAlert.module.css'

interface InlineAlertProps {
  tone?: 'error' | 'warning' | 'info'
  children: ReactNode
}

const ICONS = { error: CircleAlert, warning: TriangleAlert, info: Info } as const

/** Red (error), amber (warning) or neutral box with an icon, shown next to what it is about. */
export function InlineAlert({ tone = 'error', children }: InlineAlertProps) {
  const Icon = ICONS[tone]
  return (
    <div className={`${styles.alert} ${styles[tone]}`} role={tone === 'info' ? 'status' : 'alert'}>
      <Icon size={14} className={styles.icon} aria-hidden />
      <div className={styles.text}>{children}</div>
    </div>
  )
}
