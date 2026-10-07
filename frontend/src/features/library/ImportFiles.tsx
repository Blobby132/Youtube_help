import { Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { Checkbox } from '../../components/ui/Checkbox'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { ProgressBar } from '../../components/ui/ProgressBar'
import { useUi } from '../../state/ui'
import styles from './Library.module.css'
import { dismissImport, importStaged, setStagedAi, stageFiles, unstage, useLibrary } from './libraryStore'

const ACCEPT = '.mp4,.mov,.m4v,.webm,.mkv,.avi,.gif,.jpg,.jpeg,.png,.webp,video/*,image/*'

function size(bytes: number) {
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.max(0.1, bytes / (1 << 20)).toFixed(1)} MB`
}

/** Drop or pick your own clips (e.g. from ComfyUI), tick AI-generated, and import them. */
export function ImportFiles() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const staged = useLibrary((s) => s.staged)
  const imports = useLibrary((s) => s.imports)
  const online = useUi((s) => s.backend === 'online')

  return (
    <>
      <div
        className={`${styles.dropzone} ${over ? styles.dropzoneOver : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          setOver(false)
          stageFiles(event.dataTransfer.files)
        }}
      >
        <Upload size={16} aria-hidden />
        <span>
          Drop clips or images here, or <u>choose files</u>
        </span>
        <small>MP4, MOV, WebM, MKV, AVI, GIF, JPG, PNG, WebP</small>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        aria-label="Choose clips or images to import"
        onChange={(event) => {
          if (event.target.files) stageFiles(event.target.files)
          event.target.value = ''
        }}
      />

      {staged.length > 0 && (
        <div className={styles.staged}>
          <ul aria-label="Files to import">
            {staged.map((file) => (
              <li key={file.key} className={styles.stagedRow}>
                <span className={styles.stagedName} title={file.file.name}>
                  {file.file.name}
                </span>
                <span className={styles.stagedSize}>{size(file.file.size)}</span>
                <Checkbox label="AI-generated" checked={file.aiGenerated} onChange={(checked) => setStagedAi(file.key, checked)} />
                <button type="button" className={styles.iconButton} aria-label={`Don't import ${file.file.name}`} onClick={() => unstage(file.key)}>
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
          <p className={styles.note}>
            ComfyUI outputs (like <code>LTX_2_5_t2v_00017_.mp4</code>) are ticked as AI-generated. Change it here or later in the library.
          </p>
          <Button variant="primary" block disabled={!online} onClick={() => void importStaged()}>
            Import {staged.length} {staged.length === 1 ? 'file' : 'files'}
          </Button>
        </div>
      )}

      {Object.entries(imports).map(([key, transfer]) =>
        transfer.error ? (
          <InlineAlert key={key}>
            <p>
              Could not import {transfer.name}: {transfer.error}
            </p>
            <button type="button" className={styles.dismiss} onClick={() => dismissImport(key)}>
              <X size={11} aria-hidden /> Dismiss
            </button>
          </InlineAlert>
        ) : (
          <div key={key} className={styles.importing}>
            <ProgressBar value={transfer.progress} label={`Importing ${transfer.name}`} />
            <p className={styles.note}>{transfer.message}</p>
          </div>
        ),
      )}
    </>
  )
}
