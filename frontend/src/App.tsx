import { useEffect } from 'react'
import { PreviewPlayer } from './features/preview/PreviewPlayer'
import { StartupOverlay } from './features/projects/StartupOverlay'
import { Timeline } from './features/timeline/Timeline'
import { TopBar } from './features/topbar/TopBar'
import { LeftPanel } from './layout/LeftPanel'
import { RightPanel } from './layout/RightPanel'
import { startPersistence } from './state/project/persistence'
import { useProjectStore } from './state/project/store'
import styles from './App.module.css'

export default function App() {
  const loaded = useProjectStore((s) => s.loaded)

  useEffect(() => {
    void startPersistence()
  }, [])

  return (
    <div className={styles.app}>
      <TopBar />
      {/* Edits made before the saved project arrives would be overwritten, so lock the editor until then. */}
      <div className={styles.editor} inert={!loaded}>
        <main className={styles.workspace}>
          <LeftPanel />
          <PreviewPlayer />
          <RightPanel />
        </main>
        <Timeline />
      </div>
      {!loaded && <StartupOverlay />}
    </div>
  )
}
