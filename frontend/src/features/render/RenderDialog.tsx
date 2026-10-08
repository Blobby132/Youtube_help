import { Clapperboard, FolderOpen, LoaderCircle, Play, RotateCcw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Modal } from '../../components/ui/Modal'
import { ProgressBar } from '../../components/ui/ProgressBar'
import { Segmented } from '../../components/ui/Segmented'
import type { RenderQuality } from '../../lib/api'
import { formatDuration } from '../../lib/time'
import styles from './RenderDialog.module.css'
import {
  cancelRender,
  checkProject,
  closeRenderDialog,
  isRendering,
  openResult,
  setQuality,
  startRender,
  useRender,
} from './renderStore'

const megabytes = (bytes: number) => `${(bytes / (1 << 20)).toFixed(1)} MB`

/** Seconds since `from`, updated every second. */
function useElapsed(from: number | null, to: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (from === null || to !== null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [from, to])
  return from === null ? 0 : Math.max(0, ((to ?? now) - from) / 1000)
}

function Review() {
  const check = useRender((s) => s.check)
  const quality = useRender((s) => s.quality)
  const notice = useRender((s) => s.notice)
  if (!check) return null
  const options = check.qualities.map((q) => ({ value: q.id, label: q.label, title: q.description }))
  const chosen = check.qualities.find((q) => q.id === quality)
  const blocked = check.blockers.length > 0

  return (
    <div className={styles.body}>
      {notice && <InlineAlert tone="info">{notice}</InlineAlert>}
      <p className={styles.summary}>
        {formatDuration(check.duration)} · {check.width}×{check.height} · {check.fps.label} fps · H.264 + AAC 48 kHz
      </p>
      {check.blockers.map((text) => (
        <InlineAlert key={text}>{text}</InlineAlert>
      ))}
      {!blocked && check.warnings.length > 0 && (
        <section className={styles.warnings} aria-label="Before you render">
          <h3 className={styles.label}>Before you render</h3>
          {check.warnings.map((warning) => (
            <InlineAlert key={warning.kind + warning.message} tone="warning">
              {warning.message}
            </InlineAlert>
          ))}
          <p className={styles.hint}>You can still render; these only change how the video looks.</p>
        </section>
      )}
      {!blocked && check.warnings.length === 0 && <p className={styles.ok}>No problems found.</p>}

      <div className={styles.row}>
        <span className={styles.label}>Quality</span>
        {options.length > 1 ? (
          <Segmented<RenderQuality['id']> label="Quality" options={options} value={quality} onChange={setQuality} />
        ) : (
          <span className={styles.value}>{options[0]?.label}</span>
        )}
      </div>
      {chosen && <p className={styles.hint}>{chosen.description}</p>}

      <Button variant="primary" block icon={Clapperboard} disabled={blocked} onClick={() => void startRender()}>
        {check.warnings.length && !blocked ? 'Render anyway' : 'Render'}
      </Button>
    </div>
  )
}

function Progress() {
  const stage = useRender((s) => s.stage)
  const progress = useRender((s) => s.progress)
  const message = useRender((s) => s.message)
  const startedAt = useRender((s) => s.startedAt)
  const elapsed = useElapsed(startedAt, null)
  return (
    <div className={styles.body}>
      <ProgressBar value={progress} label="Render progress" />
      <p className={styles.progressLine}>
        <span>{message || (stage === 'preparing' ? 'Drawing the text…' : 'Rendering…')}</span>
        <span>
          {Math.round(progress * 100)}% · <span aria-label="Elapsed time">{formatDuration(elapsed)}</span> elapsed
        </span>
      </p>
      <p className={styles.hint}>You can close this window and keep working; the render carries on.</p>
      <Button icon={Square} block onClick={() => void cancelRender()}>
        Cancel render
      </Button>
    </div>
  )
}

function Finished() {
  const result = useRender((s) => s.result)
  const notice = useRender((s) => s.notice)
  const elapsed = useElapsed(useRender((s) => s.startedAt), useRender((s) => s.finishedAt))
  if (!result) return null
  return (
    <div className={styles.body}>
      <div className={styles.file}>
        <strong>{result.name}</strong>
        <span className={styles.path} title={result.folder} data-testid="render-folder">
          {result.folder}
        </span>
        <span className={styles.meta}>
          {formatDuration(result.duration)} · {result.width}×{result.height} · {result.fps} fps · {megabytes(result.size)} ·
          rendered in {formatDuration(elapsed)} ({result.quality})
        </span>
      </div>
      <div className={styles.actions}>
        <Button variant="primary" icon={Play} onClick={() => void openResult('play')}>
          Play
        </Button>
        <Button icon={FolderOpen} onClick={() => void openResult('folder')}>
          Open folder
        </Button>
      </div>
      {notice && <InlineAlert>{notice}</InlineAlert>}
      {result.containsAi && (
        <InlineAlert tone="warning">
          This video contains AI-generated clips ({result.aiClips.length}). When you upload it to YouTube, mark it as
          containing altered or synthetic content: under “Altered content”, choose Yes.
        </InlineAlert>
      )}
      <Button icon={RotateCcw} block onClick={() => void checkProject()}>
        Render again
      </Button>
    </div>
  )
}

/** Checks, quality, progress with cancel, and the finished file. */
export function RenderDialog() {
  const open = useRender((s) => s.open)
  const stage = useRender((s) => s.stage)
  const error = useRender((s) => s.error)
  const title = stage === 'done' ? 'Video ready' : isRendering(stage) ? 'Rendering' : 'Render video'

  return (
    <Modal title={title} open={open} onClose={closeRenderDialog}>
      {(stage === 'checking' || stage === 'idle') && (
        <div className={styles.body}>
          <p className={styles.checking}>
            <LoaderCircle size={14} className={styles.spin} aria-hidden /> Checking the project…
          </p>
        </div>
      )}
      {stage === 'review' && <Review />}
      {isRendering(stage) && <Progress />}
      {stage === 'done' && <Finished />}
      {stage === 'error' && (
        <div className={styles.body}>
          <InlineAlert>{error}</InlineAlert>
          <Button icon={RotateCcw} block onClick={() => void checkProject()}>
            Try again
          </Button>
        </div>
      )}
    </Modal>
  )
}
