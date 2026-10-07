import { FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { EmptyState } from '../../components/ui/EmptyState'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Modal } from '../../components/ui/Modal'
import { api } from '../../lib/api'
import { formatRelative } from '../../lib/time'
import { flushSave, openProject } from '../../state/project/persistence'
import { useProject } from '../../state/project/store'
import type { ProjectSummary } from '../../state/project/types'
import { AiIndicator } from '../library/AiIndicator'
import styles from './OpenProjectDialog.module.css'

interface OpenProjectDialogProps {
  open: boolean
  onClose: () => void
}

export function OpenProjectDialog({ open, onClose }: OpenProjectDialogProps) {
  return (
    <Modal title="Open project" open={open} onClose={onClose}>
      <ProjectList onOpened={onClose} />
    </Modal>
  )
}

function ProjectList({ onOpened }: { onOpened: () => void }) {
  const currentId = useProject((p) => p.id)
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Save first so the current project shows its latest name and time.
    flushSave()
      .then(() => api.listProjects())
      .then((list) => !cancelled && setProjects(list))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [])

  async function handleOpen(id: string) {
    if (id === currentId) return onOpened()
    setOpeningId(id)
    setError(null)
    try {
      await openProject(id)
      onOpened()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setOpeningId(null)
    }
  }

  return (
    <div className={styles.body}>
      {error && <InlineAlert>{error}</InlineAlert>}
      {!projects && !error && <p className={styles.loading}>Loading projects…</p>}
      {projects?.length === 0 && <EmptyState icon={FolderOpen}>No saved projects yet.</EmptyState>}
      {projects && projects.length > 0 && (
        <ul className={styles.list}>
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className={styles.row}
                onClick={() => void handleOpen(project.id)}
                disabled={openingId !== null}
              >
                <span className={styles.title}>
                  <span className={styles.name}>{project.name}</span>
                  {!!project.aiClips && <AiIndicator count={project.aiClips} compact />}
                </span>
                <span className={styles.meta}>
                  {project.id === currentId
                    ? 'open now'
                    : openingId === project.id
                      ? 'opening…'
                      : `edited ${formatRelative(project.updatedAt)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
