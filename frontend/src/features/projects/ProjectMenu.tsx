import { ChevronDown, FilePlus2, FolderOpen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { newProject } from '../../state/project/persistence'
import { updateProject, useProject, useProjectStore } from '../../state/project/store'
import { useUi } from '../../state/ui'
import { OpenProjectDialog } from './OpenProjectDialog'
import styles from './ProjectMenu.module.css'

const SAVE_LABEL = {
  idle: '',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
} as const

/** Project name with a dropdown for rename / New / Open, plus the autosave status. */
export function ProjectMenu() {
  const name = useProject((p) => p.name)
  const projectId = useProject((p) => p.id)
  const loaded = useProjectStore((s) => s.loaded)
  const save = useUi((s) => s.save)
  const saveError = useUi((s) => s.saveError)
  const [open, setOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        disabled={!loaded}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className={styles.projectName}>{loaded ? name : 'Loading project…'}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      <span className={styles.save} data-state={save} title={save === 'error' ? (saveError ?? undefined) : undefined}>
        {SAVE_LABEL[save]}
      </span>

      {open && (
        <div className={styles.menu} role="menu">
          <label className={styles.renameLabel} htmlFor="project-name">
            Project name
          </label>
          <input
            id="project-name"
            className={styles.rename}
            value={name}
            maxLength={80}
            onChange={(event) =>
              updateProject((p) => {
                p.name = event.target.value
              })
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') setOpen(false)
            }}
          />
          <div className={styles.separator} />
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              setOpen(false)
              void newProject()
            }}
          >
            <FilePlus2 size={15} aria-hidden /> New project
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              setOpen(false)
              setDialogOpen(true)
            }}
          >
            <FolderOpen size={15} aria-hidden /> Open project…
          </button>
          <div className={styles.separator} />
          <p className={styles.path}>projects/{projectId}/project.json</p>
        </div>
      )}

      <OpenProjectDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  )
}
