import { Check, Film, ListPlus, RotateCcw, Sparkles, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import { ProgressBar } from '../../components/ui/ProgressBar'
import { libraryFileUrl, libraryThumbnailUrl, type ShotJob } from '../../lib/api'
import { useProject } from '../../state/project/store'
import type { Scene, SceneFinal, ScenePreview } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { generateBlocker, useGenerate } from '../generate/generateStore'
import { useLibrary } from '../library/libraryStore'
import { finalOf } from './sceneOps'
import { cancelFinal, finalSource, OLD_PREVIEW, retryFinal } from './sceneFinals'
import { isPreviewActive, PREVIEW_STATUS_LABEL } from './scenePreviews'
import { generateSceneFinal } from './sceneRun'
import { addFinalToTimeline, isOnTimeline } from './sceneTimeline'
import styles from './Scenes.module.css'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

interface SceneFinalProps {
  scene: Scene
  number: number
  /** The scene's previews, oldest first (to say which one a final is from). */
  previews: readonly ScenePreview[]
  jobs: ReadonlyMap<string, ShotJob>
}

/** An AI scene's final: made from its chosen preview, so it's the same shot at the Final size. */
export function SceneFinalBlock({ scene, number, previews, jobs }: SceneFinalProps) {
  const finals = useProject((p) => p.sceneFinals)
  const final = finalOf(finals, scene.id)
  const { items, status: libraryStatus } = useLibrary()
  const status = useGenerate((s) => s.status)
  const online = useUi((s) => s.backend === 'online')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const source = finalSource(scene, previews, libraryStatus === 'ready' ? items : null)
  const problem = 'problem' in source ? source.problem : null
  const blocker = generateBlocker(status, online) ?? status?.finalsProblem ?? null
  const job = final ? jobs.get(final.jobId) : undefined
  const active = !!final && isPreviewActive(job ?? final)
  const finalItem = final?.itemId ? items.find((i) => i.id === final.itemId) : undefined
  const lost = final?.status === 'done' && !finalItem && libraryStatus === 'ready'
  const regenerate = !!final && !lost
  const fromOther = final && final.previewId !== scene.selectedPreviewId && previews.some((p) => p.id === scene.selectedPreviewId)
  // A failed final of the chosen preview has its own Retry (same refine seed) instead.
  const failed = final?.status === 'error' || final?.status === 'cancelled'
  const showButton = !active && !(failed && !fromOther)

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      await generateSceneFinal(scene.id, regenerate)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  const previewName = (previewId: string) => {
    const index = previews.findIndex((p) => p.id === previewId)
    return index < 0 ? 'a deleted preview' : `preview ${index + 1}`
  }

  return (
    <div className={styles.finalBlock} data-testid="scene-final" aria-label={`Final of scene ${number}`} role="group">
      <span className={styles.label}>Final</span>
      {final && <FinalRow final={final} job={job} from={previewName(final.previewId)} number={number} />}
      {problem === OLD_PREVIEW ? (
        <p className={styles.warning} role="note" data-testid="final-mismatch">
          <TriangleAlert size={11} aria-hidden /> {OLD_PREVIEW}
        </p>
      ) : (
        status?.finalsProblem && (
          <p className={styles.warning} role="note">
            <TriangleAlert size={11} aria-hidden /> {status.finalsProblem}
          </p>
        )
      )}
      {fromOther && !active && (
        <p className={styles.note} data-testid="final-other-preview">
          This final is from {previewName(final.previewId)}, but you’ve chosen {previewName(scene.selectedPreviewId!)}. Regenerate final makes it
          from your choice.
        </p>
      )}
      {showButton && (
        <Button
          block
          icon={Sparkles}
          accentIcon
          loading={busy}
          disabled={problem !== null || blocker !== null}
          title={problem ?? blocker ?? (regenerate ? 'Make the final again from the chosen preview, with a new refine seed' : undefined)}
          onClick={() => void generate()}
        >
          {regenerate ? 'Regenerate final' : 'Generate final'}
        </Button>
      )}
      {showButton && (
        <p className={styles.note}>
          {problem && problem !== OLD_PREVIEW
            ? problem
            : regenerate
              ? 'Regenerate final makes it again from the chosen preview with a new refine seed: the same shot, with small differences in detail.'
              : 'Made from the chosen preview itself (its first pass, upscaled and refined), so it’s the same shot at the Final size.'}
        </p>
      )}
      {error && (
        <p className={styles.message} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

interface FinalRowProps {
  final: SceneFinal
  job: ShotJob | undefined
  /** "preview 2" */
  from: string
  number: number
}

/** The scene's final: its picture (hover to play), state, and Add to timeline. */
function FinalRow({ final, job, from, number }: FinalRowProps) {
  const [hover, setHover] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const item = useLibrary((s) => (final.itemId ? s.items.find((i) => i.id === final.itemId) : undefined))
  const libraryReady = useLibrary((s) => s.status === 'ready')
  const onTimeline = useProject((p) => !!item && isOnTimeline(p, item.id))
  const status = job?.status ?? final.status
  const failure = job?.error ?? final.error
  const active = isPreviewActive({ status })
  const progress = job?.progress ?? 0
  const label =
    status === 'running' || status === 'saving'
      ? `Generating ${Math.round(progress * 100)}%`
      : status === 'queued' && job?.queuePosition
        ? `Queued (${job.queuePosition} ahead)`
        : PREVIEW_STATUS_LABEL[status]

  async function retry() {
    setError(null)
    try {
      await retryFinal(final.id)
    } catch (failed) {
      setError(message(failed))
    }
  }

  return (
    <div className={styles.preview} data-testid="scene-final-row" data-status={status}>
      <div className={styles.thumb} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {item?.thumbnail ? <img src={libraryThumbnailUrl(item.id)} alt="" loading="lazy" draggable={false} /> : <Film size={14} className={styles.thumbIcon} aria-hidden />}
        {hover && item && <video src={libraryFileUrl(item.id)} muted autoPlay loop playsInline />}
      </div>
      <div className={styles.previewInfo}>
        <div className={styles.previewTop}>
          <span className={styles.previewName}>
            Final from {from}
            {item ? ` · ${item.width}×${item.height}` : ''}
          </span>
          <span className={styles.chip} data-status={status}>
            {label}
          </span>
        </div>
        {(status === 'running' || status === 'saving') && <ProgressBar value={progress} label={`Scene ${number} final progress`} />}
        {active && job?.message && <span className={styles.note}>{job.message}</span>}
        {status === 'error' && failure && <p className={styles.previewError}>{failure}</p>}
        {status === 'done' && !item && libraryReady && <p className={styles.previewError}>Its clip is no longer in the library. Generate final makes a new one.</p>}
        {error && (
          <p className={styles.previewError} role="alert">
            {error}
          </p>
        )}
        <div className={styles.previewActions}>
          {status === 'done' &&
            item &&
            (onTimeline ? (
              <span className={styles.chosenLabel}>
                <Check size={11} aria-hidden /> On the timeline
              </span>
            ) : (
              <button type="button" className={`${styles.small} ${styles.use}`} onClick={() => addFinalToTimeline(final.sceneId)}>
                <ListPlus size={11} aria-hidden /> Add to timeline
              </button>
            ))}
          {(status === 'error' || status === 'cancelled') && (
            <button type="button" className={styles.small} onClick={() => void retry()} title="Make this final again, from the same preview with the same refine seed">
              <RotateCcw size={11} aria-hidden /> Retry
            </button>
          )}
          {active && status !== 'saving' && (
            <button type="button" className={styles.small} onClick={() => cancelFinal(final.id)}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
