import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import styles from './EmptyState.module.css'

interface EmptyStateProps {
  icon: LucideIcon
  children: ReactNode
}

/** Dashed placeholder for lists that have nothing in them yet. */
export function EmptyState({ icon: Icon, children }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <Icon size={18} aria-hidden />
      <p>{children}</p>
    </div>
  )
}
