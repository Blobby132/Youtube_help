import { Clapperboard, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Section } from '../../components/ui/Section'
import { captionsOutOfDate } from '../../state/project/selectors'
import { useProject } from '../../state/project/store'
import { useUi } from '../../state/ui'
import { checkComfy, useGenerate } from '../generate/generateStore'
import { WORDS_PER_MINUTE } from '../media/autofillPlan'
import { AiWriteSection } from './AiWriteSection'
import { GenerationPanel } from './GenerationPanel'
import { PreviewRow } from './SceneAiShots'
import { SceneCard } from './SceneCard'
import { addSceneAtPlayhead, createScenes } from './sceneEdits'
import { orphanPreviews } from './sceneOps'
import { narration, sceneTiming, type SceneTiming } from './scenePlan'
import styles from './Scenes.module.css'

const COMFY_CHECK_MS = 10_000

function timingNote(timing: SceneTiming, stale: boolean, hasVoiceover: boolean): string {
  if (timing.source === 'captions') return 'Timed with the captions’ words.'
  if (stale) return 'The captions are out of date, so times are estimated from the script. Regenerate the captions for exact times.'
  if (hasVoiceover) return 'No captions yet, so times are estimated by spreading the script over the voiceover. Generate captions for exact times.'
  return `No voiceover yet, so times are estimated from the script (${WORDS_PER_MINUTE} words a minute).`
}

/** The Scenes tab: the video cut into scenes, each with an AI clip or stock footage. */
export function ScenesPanel() {
  const scenes = useProject((p) => p.scenes)
  const previews = useProject((p) => p.scenePreviews)
  const script = useProject((p) => p.script)
  const voiceover = useProject((p) => p.voiceover)
  const captions = useProject((p) => p.captions)
  const jobs = useGenerate((s) => s.jobs)
  const generateError = useGenerate((s) => s.error)
  const online = useUi((s) => s.backend === 'online')
  const [message, setMessage] = useState<string | null>(null)
  const timing = useMemo(() => sceneTiming({ script, voiceover, captions }), [script, voiceover, captions])
  const stale = captionsOutOfDate({ captions, voiceover })
  const orphans = useMemo(() => orphanPreviews(previews, scenes), [previews, scenes])
  const hasAi = scenes.some((s) => s.source === 'ai')

  // Whether ComfyUI is open, while there are AI scenes to make previews for (as the Media tab does).
  useEffect(() => {
    if (!online || !hasAi) return
    void checkComfy()
    const timer = setInterval(() => void checkComfy(), COMFY_CHECK_MS)
    return () => clearInterval(timer)
  }, [online, hasAi])

  return (
    // Every scene change is on the timeline's undo history, so Ctrl+Z undoes it even from a field.
    <div className={styles.panel} data-undo="timeline">
      <Section
        label="Scenes"
        hint="The video cut into scenes of 2 to 5 seconds, at sentence ends, then at commas or pauses. Each gets its own picture: an AI clip or stock footage."
      >
        <Button block icon={Clapperboard} accentIcon onClick={() => setMessage(createScenes())}>
          Create scenes from script
        </Button>
        <p className={styles.timing} data-testid="scene-timing">
          {timingNote(timing, stale, voiceover !== null)}
        </p>
        {message && <InlineAlert tone="info">{message}</InlineAlert>}
        {generateError && hasAi && <InlineAlert>{generateError}</InlineAlert>}
      </Section>

      <AiWriteSection />

      {hasAi && <GenerationPanel />}

      <Section
        label={scenes.length ? `Scene list · ${scenes.length}` : 'Scene list'}
        hint="In time order. Type a scene's start and end (Enter applies, Escape cancels), or drag its edges on the Scenes lane; an edge shared with the next scene moves both. Undo covers every scene change."
      >
        {scenes.length === 0 ? (
          <EmptyState icon={Clapperboard}>No scenes yet. Write the script, then click Create scenes from script, or add scenes one by one.</EmptyState>
        ) : (
          <ol className={styles.list} aria-label="Scenes">
            {scenes.map((scene, index) => (
              <SceneCard key={scene.id} scene={scene} number={index + 1} isLast={index === scenes.length - 1} narration={narration(timing.words, scene)} />
            ))}
          </ol>
        )}
        <Button block icon={Plus} onClick={() => addSceneAtPlayhead()}>
          Add scene
        </Button>
      </Section>

      {orphans.length > 0 && (
        <Section
          label={`Previews from removed scenes · ${orphans.length}`}
          hint="Their scene was deleted, merged into another or replaced by Create scenes. Undo brings a scene back with its previews; delete the ones you don't need."
        >
          <ul className={styles.previews} aria-label="Previews from removed scenes">
            {orphans.map((preview, index) => (
              <PreviewRow key={preview.id} preview={preview} name={`Preview ${index + 1}`} job={jobs.find((j) => j.id === preview.jobId)} />
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}
