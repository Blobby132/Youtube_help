import type { ReactNode } from 'react'
import { Segmented, type SegmentedOption } from '../components/ui/Segmented'
import styles from './SidePanel.module.css'

interface SidePanelProps<T extends string> {
  label: string
  tabs: readonly SegmentedOption<T>[]
  tab: T
  onTabChange: (tab: T) => void
  children: ReactNode
}

/** A side column: tab bar on top, scrollable content below. */
export function SidePanel<T extends string>({ label, tabs, tab, onTabChange, children }: SidePanelProps<T>) {
  return (
    <aside className={styles.panel} aria-label={label}>
      <div className={styles.tabs}>
        <Segmented variant="tabs" options={tabs} value={tab} onChange={onTabChange} label={label} />
      </div>
      <div className={styles.body} role="tabpanel">
        {children}
      </div>
    </aside>
  )
}
