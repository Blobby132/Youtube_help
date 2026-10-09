import { Check, Film, LoaderCircle, PenLine, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { ProgressBar } from '../../components/ui/ProgressBar'
import { Segmented } from '../../components/ui/Segmented'
import { libraryFileUrl, libraryThumbnailUrl, type ShotJob } from '../../lib/api'
import { useProject } from '../../state/project/store'
import type { Scene, ScenePreview } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { generateBlocker, useGenerate } from '../generate/generateStore'
import { useLibrary } from '../library/libraryStore'
import { selectPreview, setPreviewCount, updateScene } from './sceneEdits'
import { MAX_PREVIEWS, MIN_PREVIEWS, previewSeconds, previewsOf } from './sceneOps'
import { SceneFinalBlock } from './SceneFinal'
import { isOldPreview } from './sceneFinals'
import { cancelPreview, deletePreview, isPreviewActive, PREVIEW_STATUS_LABEL, previewStatusLine, retryPreview } from './scenePreviews'
import { generateScenePreviews } from './sceneRun'
import { RawOutput } from './AiWriteSection'
import { comfyJobsActive, llmBlocker, rewriteScenePrompt, useLlm } from './llmStore'
import styles from './Scenes.module.css'

const COUNTS = Array.from({ length: MAX_PREVIEWS - MIN_PREVIEWS + 1 }, (_, i) => {
  const value = MIN_PREVIEWS + i
  return { value, label: String(value), title: `${value} ${value === 1 ? 'preview' : 'previews'}, each with its own seed` }
})

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The jobs list by job id (live progress; the project keeps the last known state). */
function useJobs(): Map<string, ShotJob> {
  const jobs = useGenerate((s) => s.jobs)
  return useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs])
}

/** An AI scene: its ComfyUI prompt, its Draft previews to choose from, and its final. */
export function SceneAiShots({ scene, number }: { scene: Scene; number: number }) {
  const all = useProject((p) => p.scenePreviews)
  const previews = useMemo(() => previewsOf(all, scene.id), [all, scene.id])
  const jobs = useJobs()
  const status = useGenerate((s) => s.status)
  const online = useUi((s) => s.backend === 'online')
  const blocker = generateBlocker(status, online)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prompt = scene.prompt.trim()
  const chosen = previews.some((p) => p.id === scene.selectedPreviewId) ? scene.selectedPreviewId : null
  const active = previews.filter((p) => isPreviewActive(jobs.get(p.jobId) ?? p))
  const llmStatus = useLlm((s) => s.status)
  const llmRun = useLlm((s) => s.run)
  const promptFailure = useLlm((s) => s.promptFailures[scene.id])
  const comfyJobs = useGenerate((s) => comfyJobsActive(s.jobs))
  const llmBlocked = llmBlocker(llmStatus, online, comfyJobs)
  const rewriting = llmRun?.kind === 'prompt' && llmRun.sceneId === scene.id

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      await generateScenePreviews(scene.id)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className={styles.field}>
        <div className={styles.fieldHead}>
          <span className={styles.label}>ComfyUI prompt</span>
          <button
            type="button"
            className={styles.small}
            disabled={llmBlocked !== null || llmRun !== null}
            title={llmBlocked ?? (llmRun ? 'The language model is busy' : 'Have the language model write this prompt again, by prompts/ltx_guide.md')}
            aria-label={`Rewrite the prompt of scene ${number}`}
            onClick={() => void rewriteScenePrompt(scene.id)}
          >
            {rewriting ? <LoaderCircle size={11} className={styles.spin} aria-hidden /> : <PenLine size={11} aria-hidden />} Rewrite prompt
          </button>
        </div>
        <textarea
          className={styles.text}
          rows={3}
          value={scene.prompt}
          maxLength={4000}
          placeholder="The shot for LTX-2.5, e.g. Close-up of an airplane window at sunrise, clouds drifting past, cinematic"
          aria-label={`ComfyUI prompt of scene ${number}`}
          onChange={(event) => updateScene(scene.id, { prompt: event.target.value }, 'prompt')}
        />
        {rewriting && (
          <span className={styles.note} data-testid="prompt-progress">
            {llmRun.message}
          </span>
        )}
        {promptFailure && (
          <div className={styles.message} role="alert">
            <div>
              {promptFailure.message}
              <RawOutput failure={promptFailure} />
            </div>
          </div>
        )}
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Previews</span>
        <Segmented label={`Previews of scene ${number}`} options={COUNTS} value={scene.previewCount} onChange={(count) => setPreviewCount(scene.id, count)} />
      </div>
      <Button
        block
        icon={Sparkles}
        accentIcon
        loading={busy}
        disabled={!prompt || blocker !== null}
        title={blocker ?? (prompt ? undefined : 'Write the ComfyUI prompt first')}
        onClick={() => void generate()}
      >
        Generate previews
      </Button>
      <p className={styles.note}>
        {previewSeconds(scene)} s each, every one with its own seed, at half the final’s size: each is the first pass of its final, so
        the final matches it. More previews are added to these.
        {blocker && status && ` ${blocker}`}
      </p>
      {error && (
        <p className={styles.message} role="alert">
          {error}
        </p>
      )}

      {active.length > 0 && (
        <ul className={styles.status} aria-label={`Scene ${number} jobs`}>
          {active.map((preview) => {
            const job = jobs.get(preview.jobId)
            const live = job?.status ?? preview.status
            return (
              <li key={preview.id} className={styles.statusLine} data-testid="scene-status">
                <span data-testid="scene-status-text">{previewStatusLine(number, previews.indexOf(preview) + 1, previews.length, preview, job)}</span>
                {(live === 'running' || live === 'saving') && <ProgressBar value={job?.progress ?? 0} label={`Preview ${previews.indexOf(preview) + 1} progress`} />}
                {job?.message && <span>{job.message}</span>}
              </li>
            )
          })}
        </ul>
      )}

      {previews.length > 0 && (
        <ul className={styles.previews} aria-label={`Previews of scene ${number}`}>
          {previews.map((preview, index) => (
            <PreviewRow
              key={preview.id}
              preview={preview}
              name={`Preview ${index + 1} of ${previews.length}`}
              job={jobs.get(preview.jobId)}
              chosen={preview.id === chosen}
              onUse={() => selectPreview(scene.id, preview.id)}
            />
          ))}
        </ul>
      )}

      <SceneFinalBlock scene={scene} number={number} previews={previews} jobs={jobs} />
    </>
  )
}

interface PreviewRowProps {
  preview: ScenePreview
  name: string
  job: ShotJob | undefined
  chosen?: boolean
  /** "Use this"; left out for previews whose scene is gone. */
  onUse?: () => void
}

/** One preview: its picture (hover to play), seed and state, and what you can do with it. */
export function PreviewRow({ preview, name, job, chosen = false, onUse }: PreviewRowProps) {
  const [hover, setHover] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const item = useLibrary((s) => (preview.itemId ? s.items.find((i) => i.id === preview.itemId) : undefined))
  const libraryReady = useLibrary((s) => s.status === 'ready')
  const status = job?.status ?? preview.status
  const failure = job?.error ?? preview.error
  const active = isPreviewActive({ status })
  const label = status === 'running' || status === 'saving' ? `Generating ${Math.round((job?.progress ?? 0) * 100)}%` : PREVIEW_STATUS_LABEL[status]

  async function retry() {
    setError(null)
    try {
      await retryPreview(preview.id)
    } catch (failed) {
      setError(message(failed))
    }
  }

  return (
    <li className={`${styles.preview} ${chosen ? styles.chosen : ''}`} data-testid="scene-preview" data-status={status} aria-current={chosen || undefined}>
      <div className={styles.thumb} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {item?.thumbnail ? <img src={libraryThumbnailUrl(item.id)} alt="" loading="lazy" draggable={false} /> : <Film size={14} className={styles.thumbIcon} aria-hidden />}
        {hover && item && <video src={libraryFileUrl(item.id)} muted autoPlay loop playsInline />}
      </div>
      <div className={styles.previewInfo}>
        <div className={styles.previewTop}>
          <span className={styles.previewName} title={preview.prompt}>
            {name} · seed {preview.seed}
          </span>
          <span className={styles.chip} data-status={status}>
            {label}
          </span>
        </div>
        {status === 'error' && failure && <p className={styles.previewError}>{failure}</p>}
        {status === 'done' && !item && libraryReady && <p className={styles.previewError}>Its clip is no longer in the library.</p>}
        {status === 'done' && isOldPreview(item) && (
          <p className={styles.previewOld} data-testid="old-preview">
            Made before finals could match previews: a final made from it would be a different video.
          </p>
        )}
        {error && (
          <p className={styles.previewError} role="alert">
            {error}
          </p>
        )}
        <div className={styles.previewActions}>
          {status === 'done' && item && onUse && (chosen ? (
            <span className={styles.chosenLabel}>
              <Check size={11} aria-hidden /> Selected
            </span>
          ) : (
            <button type="button" className={`${styles.small} ${styles.use}`} onClick={onUse}>
              Use this
            </button>
          ))}
          {(status === 'error' || status === 'cancelled') && (
            <button type="button" className={styles.small} onClick={() => void retry()} title="Make this preview again, with the same seed">
              <RotateCcw size={11} aria-hidden /> Retry
            </button>
          )}
          {active && status !== 'saving' && (
            <button type="button" className={styles.small} onClick={() => cancelPreview(preview.id)}>
              Cancel
            </button>
          )}
          <span className={styles.spacer} />
          {!active && (
            <button
              type="button"
              className={`${styles.iconButton} ${styles.danger}`}
              aria-label={`Delete ${name.toLowerCase()}`}
              title={item ? 'Delete this preview and its clip from the library' : 'Remove this preview'}
              onClick={() => void deletePreview(preview.id)}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
    </li>
  )
}
