import { useState } from 'react'
import { formatTimecode } from '../../lib/time'
import styles from './RankingPanel.module.css'

interface TimeFieldProps {
  label: string
  value: number
  /** Applies the typed text. Returns why it couldn't, or null once it's done. */
  onApply: (text: string) => string | null
  /** The message to show under the entry, or null to clear it. */
  onMessage: (message: string | null) => void
}

/**
 * An entry's start or end time as a field. Type a time and press Enter to apply it (leaving the
 * field applies it too); Escape puts the entry's time back. A time that can't be used leaves
 * the entry as it was and shows why.
 */
export function TimeField({ label, value, onApply, onMessage }: TimeFieldProps) {
  /** The typed text, until it's applied or cancelled. */
  const [draft, setDraft] = useState<string | null>(null)

  /** After Enter the text stays for fixing if it can't be used; after leaving it goes back. */
  function apply(keepOnError: boolean) {
    if (draft === null) return
    const message = onApply(draft)
    onMessage(message)
    if (!message || !keepOnError) setDraft(null)
  }

  return (
    <input
      className={styles.timeInput}
      value={draft ?? formatTimecode(value)}
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      // While there's typing, Ctrl+Z undoes it; otherwise it undoes the last timeline edit.
      data-undo={draft === null ? 'timeline' : 'field'}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          apply(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setDraft(null)
          onMessage(null)
        }
      }}
      onBlur={() => apply(false)}
    />
  )
}
