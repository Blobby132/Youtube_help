import { CircleAlert, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import styles from './InlineAlert.module.css'

interface InlineAlertProps {
  tone?: 'error' | 'info'
  children: ReactNode
}

/** Red-tinted (or neutral) box with an icon, shown inline below the control it relates to. */
export function InlineAlert({ tone = 'error', children }: InlineAlertProps) {
  const Icon = tone === 'error' ? CircleAlert : Info
  return (
    <div className={`${styles.alert} ${styles[tone]}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={14} className={styles.icon} aria-hidden />
      <div className={styles.text}>{children}</div>
    </div>
  )
}
