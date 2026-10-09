import { ListPlus, RotateCcw, Sparkles, TriangleAlert, Wand } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { ProgressBar } from '../../components/ui/ProgressBar'
import { Section } from '../../components/ui/Section'
import type { ShotJob } from '../../lib/api'
import { useProject } from '../../state/project/store'
import { useUi } from '../../state/ui'
import { generateBlocker, useGenerate } from '../generate/generateStore'
import { useLibrary } from '../library/libraryStore'
import {
  allFinalsBlocker,
  allPreviewsBlocker,
  closeRun,
  generateAllFinals,
  generateAllPreviews,
  retryStep,
  runView,
  scenesNeedingFinals,
  scenesWithoutPreviews,
  type StepView,
} from './sceneRun'
import { addAllFinalsToTimeline, describePlacement, finalsToPlace, type FinalPlacement } from './sceneTimeline'
import styles from './Scenes.module.css'

const STATE_LABEL: Record<StepView['state'], string> = {
  starting: 'Starting',
  queued: 'Queued',
  running: 'Generating',
  done: 'Completed',
  error: 'Failed',
}

/** The AI scenes as a whole: previews and finals for all of them, their progress, and putting
 * the finals on the timeline. */
export function GenerationPanel() {
  const scenes = useProject((p) => p.scenes)
  const scenePreviews = useProject((p) => p.scenePreviews)
  const sceneFinals = useProject((p) => p.sceneFinals)
  const clips = useProject((p) => p.clips)
  const run = useProject((p) => p.generationRun)
  const allJobs = useGenerate((s) => s.jobs)
  const jobs = useMemo(() => new Map<string, ShotJob>(allJobs.map((job) => [job.id, job])), [allJobs])
  const status = useGenerate((s) => s.status)
  const online = useUi((s) => s.backend === 'online')
  const items = useLibrary((s) => s.items)
  const [busy, setBusy] = useState<'previews' | 'finals' | null>(null)
  const [asking, setAsking] = useState<FinalPlacement[] | null>(null)

  const records = { scenes, scenePreviews, sceneFinals }
  const blocker = generateBlocker(status, online)
  const previewsBlocker = allPreviewsBlocker(records)
  const finalsBlocker = allFinalsBlocker(records) ?? status?.finalsProblem ?? null
  const toPlace = finalsToPlace({ scenes, sceneFinals, clips }, items)
  const view = run ? runView(run, records, jobs) : null

  async function start(kind: 'previews' | 'finals') {
    setBusy(kind)
    try {
      await (kind === 'previews' ? generateAllPreviews() : generateAllFinals())
    } finally {
      setBusy(null)
    }
  }

  function addAll() {
    if (toPlace.some((p) => p.covered)) setAsking(toPlace)
    else addAllFinalsToTimeline(true)
  }

  const answer = (replace: boolean | null) => {
    if (replace !== null) addAllFinalsToTimeline(replace)
    setAsking(null)
  }

  const withoutPreviews = scenesWithoutPreviews(records).length
  const needingFinals = scenesNeedingFinals(records).length
  const covered = asking?.filter((p) => p.covered) ?? []
  const empty = (asking?.length ?? 0) - covered.length

  return (
    <Section
      label="AI scenes"
      hint="Previews and finals for every AI scene at once. They go through ComfyUI's queue one at a time; a scene that fails can be retried on its own while the others keep going."
    >
      <div className={styles.batch}>
        <Button
          icon={Sparkles}
          accentIcon
          loading={busy === 'previews'}
          disabled={blocker !== null || previewsBlocker !== null}
          title={blocker ?? previewsBlocker ?? `Previews for the ${withoutPreviews} AI ${withoutPreviews === 1 ? 'scene' : 'scenes'} without any`}
          onClick={() => void start('previews')}
        >
          Generate all previews
        </Button>
        <Button
          icon={Wand}
          accentIcon
          loading={busy === 'finals'}
          disabled={blocker !== null || finalsBlocker !== null}
          title={blocker ?? finalsBlocker ?? `Finals for ${needingFinals} ${needingFinals === 1 ? 'scene' : 'scenes'}, from their chosen previews`}
          onClick={() => void start('finals')}
        >
          Generate all finals
        </Button>
        <Button
          icon={ListPlus}
          disabled={!toPlace.length}
          title={toPlace.length ? 'Put each finished final over its scene' : 'No finished finals that aren’t on the timeline yet'}
          onClick={addAll}
        >
          Add all to timeline
        </Button>
      </div>
      <p className={styles.note} data-testid="batch-note">
        {finalsBlocker && !status?.finalsProblem ? `Generate all finals: ${finalsBlocker}` : 'Neither button chooses a preview for you.'}
      </p>
      {status?.finalsProblem && (
        <p className={styles.warning} role="note">
          <TriangleAlert size={11} aria-hidden /> {status.finalsProblem}
        </p>
      )}

      {view && view.steps.length > 0 && (
        <div className={styles.run} role="region" aria-label="Generation progress" data-testid="run-panel">
          <div className={styles.runHead}>
            <span data-testid="run-total">
              Total {Math.round(view.total * 100)}%{!view.active && (view.failed ? ` · ${view.failed} failed` : ' · done')}
            </span>
            {!view.active && (
              <button type="button" className={styles.small} onClick={closeRun}>
                Close
              </button>
            )}
          </div>
          <ProgressBar value={view.total} label="Total progress" />
          <ul className={styles.runSteps}>
            {view.steps.map((step) => (
              <li key={`${step.sceneId}-${step.kind}`} className={styles.runStep} data-testid="run-step" data-state={step.state}>
                <div className={styles.previewTop}>
                  <span className={styles.runScene}>Scene {step.number}</span>
                  <span data-testid="run-step-text" className={styles.runText}>
                    {step.text}
                  </span>
                  <span className={styles.chip} data-status={step.state === 'starting' ? 'queued' : step.state}>
                    {STATE_LABEL[step.state]}
                  </span>
                </div>
                {step.state === 'running' && <ProgressBar value={step.progress} label={`Scene ${step.number} progress`} />}
                {step.error && <p className={styles.previewError}>{step.error}</p>}
                {step.state === 'error' && (
                  <div className={styles.previewActions}>
                    <button
                      type="button"
                      className={styles.small}
                      aria-label={`Retry scene ${step.number}`}
                      title="Try again for this scene only"
                      onClick={() => void retryStep(step.sceneId, step.kind)}
                    >
                      <RotateCcw size={11} aria-hidden /> Retry
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Modal title="Add all finals to the timeline" open={asking !== null} onClose={() => answer(null)}>
        <div className={styles.ask}>
          <p>{covered.length === 1 ? 'This scene already has clips in its time:' : 'These scenes already have clips in their time:'}</p>
          <ul>
            {covered.map((p) => (
              <li key={p.sceneId}>{describePlacement(p)}</li>
            ))}
          </ul>
          <p>Replace them with the finals? Undo (Ctrl+Z) brings them back.</p>
          <div className={styles.askActions}>
            <Button variant="primary" onClick={() => answer(true)}>
              Replace them
            </Button>
            {empty > 0 && (
              <Button onClick={() => answer(false)}>
                Only the {empty} empty {empty === 1 ? 'scene' : 'scenes'}
              </Button>
            )}
            <Button variant="ghost" onClick={() => answer(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </Section>
  )
}
