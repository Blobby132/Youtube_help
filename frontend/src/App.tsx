import { useEffect } from 'react'
import { startShotPolling } from './features/generate/generateStore'
import { loadLibrary, useLibrary } from './features/library/libraryStore'
import { PreviewPlayer } from './features/preview/PreviewPlayer'
import { StartupOverlay } from './features/projects/StartupOverlay'
import { followPreviewJobs } from './features/scenes/scenePreviews'
import { Timeline } from './features/timeline/Timeline'
import { TopBar } from './features/topbar/TopBar'
import { LeftPanel } from './layout/LeftPanel'
import { RightPanel } from './layout/RightPanel'
import { startPersistence } from './state/project/persistence'
import { useProjectStore } from './state/project/store'
import { useUi } from './state/ui'
import styles from './App.module.css'

export default function App() {
  const loaded = useProjectStore((s) => s.loaded)
  const online = useUi((s) => s.backend === 'online')

  useEffect(() => {
    void startPersistence()
    // Scene previews' job state is saved with the project as the jobs list changes.
    followPreviewJobs()
  }, [])

  // The shared media library: the timeline and preview need it, not just the Media tab.
  // (Re)loaded whenever the backend comes online.
  useEffect(() => {
    if (online && useLibrary.getState().status !== 'loading') void loadLibrary()
    // Shots ComfyUI is making keep going in the backend; follow them from any tab.
    if (online) startShotPolling()
  }, [online])

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
