import { LoaderCircle } from 'lucide-react'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { useUi } from '../../state/ui'
import styles from './StartupOverlay.module.css'

/** Covers the editor until the backend is reachable and the last project is open. */
export function StartupOverlay() {
  const backend = useUi((s) => s.backend)
  const loadError = useUi((s) => s.loadError)

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        {loadError ? (
          <InlineAlert>Could not open your projects: {loadError}</InlineAlert>
        ) : backend === 'offline' ? (
          <InlineAlert>
            The backend is not running. Start the app with <code>npm run dev</code> (or <code>start.bat</code>); this
            page connects as soon as it is up.
          </InlineAlert>
        ) : (
          <p className={styles.loading}>
            <LoaderCircle size={16} className={styles.spin} aria-hidden />
            {backend === 'connecting' ? 'Connecting to the backend…' : 'Opening your last project…'}
          </p>
        )}
      </div>
    </div>
  )
}
