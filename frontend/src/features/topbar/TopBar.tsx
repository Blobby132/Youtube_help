import { Clapperboard } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { formatDuration } from '../../lib/time'
import { canRender, projectDuration } from '../../state/project/selectors'
import { useProject } from '../../state/project/store'
import { CANVAS } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { ProjectMenu } from '../projects/ProjectMenu'
import styles from './TopBar.module.css'

const BACKEND_LABEL = {
  connecting: 'Connecting…',
  online: 'Backend online',
  offline: 'Backend offline',
} as const

export function TopBar() {
  const clipCount = useProject((p) => p.clips.length)
  const duration = useProject(projectDuration)
  const renderable = useProject(canRender)
  const backend = useUi((s) => s.backend)

  return (
    <header className={styles.bar}>
      <div className={styles.left}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden>
            <Clapperboard size={14} strokeWidth={2.4} />
          </span>
          <span className={styles.name}>Shorts Creator</span>
        </div>
        <span className={styles.divider} aria-hidden />
        <ProjectMenu />
      </div>

      <p className={styles.status}>
        {clipCount} {clipCount === 1 ? 'clip' : 'clips'} · {formatDuration(duration)} · {CANVAS.width}×
        {CANVAS.height}
      </p>

      <div className={styles.right}>
        <span
          className={styles.backend}
          data-status={backend}
          title={
            backend === 'offline'
              ? 'The Python backend is not answering. Start the app with `npm run dev`.'
              : undefined
          }
        >
          <span className={styles.dot} aria-hidden />
          {BACKEND_LABEL[backend]}
        </span>
        <Button
          variant="primary"
          icon={Clapperboard}
          disabled={!renderable}
          title={renderable ? 'Render the final MP4' : 'Add a voiceover and at least one clip to render'}
        >
          Render
        </Button>
      </div>
    </header>
  )
}
