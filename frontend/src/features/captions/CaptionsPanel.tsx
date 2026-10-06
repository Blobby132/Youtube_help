import { Captions, TextCursorInput } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Checkbox } from '../../components/ui/Checkbox'
import { EmptyState } from '../../components/ui/EmptyState'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { ProgressBar } from '../../components/ui/ProgressBar'
import { Section } from '../../components/ui/Section'
import { captionsOutOfDate } from '../../state/project/selectors'
import { updateProject, useProject } from '../../state/project/store'
import { useUi } from '../../state/ui'
import { CaptionList } from './CaptionList'
import styles from './CaptionsPanel.module.css'
import { CaptionStyleControls } from './CaptionStyleControls'
import { generateCaptions, useCaptionTasks } from './captionTasks'

export function CaptionsPanel() {
  const enabled = useProject((p) => p.captions.enabled)
  const voiceoverFile = useProject((p) => p.voiceover?.file ?? null)
  const stale = useProject(captionsOutOfDate)
  const source = useProject((p) => p.captions.source)
  const wordCount = useProject((p) => p.captions.words.length)
  const backend = useUi((s) => s.backend)
  const model = useUi((s) => s.health?.captions)
  const task = useCaptionTasks((s) => s.task)
  const error = useCaptionTasks((s) => s.error)
  const matched = useCaptionTasks((s) => s.matched)
  const hasCaptions = wordCount > 0

  return (
    <>
      {/* Pinned to the top of the panel: you are often scrolled down in the caption list or
          the style controls when the voiceover changes, and must still see this. */}
      {stale && !task && (
        <div className={styles.pinned}>
          <InlineAlert tone="warning">
            <p>The voiceover changed after these captions were made, so their timing no longer matches.</p>
            <button
              type="button"
              className={styles.pinnedAction}
              disabled={backend !== 'online'}
              onClick={() => void generateCaptions()}
            >
              Regenerate captions
            </button>
          </InlineAlert>
        </div>
      )}
      <Section
        label="Captions"
        hint="Timed against the voiceover. Regenerate after you change the script."
        action={
          <Checkbox
            checked={enabled}
            onChange={(value) =>
              updateProject((p) => {
                p.captions.enabled = value
              })
            }
          />
        }
      >
        <Button
          variant="primary"
          block
          size="lg"
          icon={Captions}
          loading={task !== null}
          disabled={!voiceoverFile || backend !== 'online'}
          onClick={() => void generateCaptions()}
        >
          {task ? `Generating… ${Math.round(task.progress * 100)}%` : hasCaptions ? 'Regenerate captions' : 'Generate captions'}
        </Button>
        {task && (
          <div className={styles.progress}>
            <ProgressBar value={task.progress} label="Caption progress" />
            <p className={styles.note}>{task.message}</p>
          </div>
        )}
        {error && <InlineAlert>{error}</InlineAlert>}
        {!voiceoverFile && <InlineAlert>Generate the voiceover first: caption timing is derived from it.</InlineAlert>}
        {hasCaptions && !stale && !task && (
          <p className={styles.note}>
            {source === 'script'
              ? `Your script's wording, timed to the voiceover${matched !== null ? ` (${Math.round(matched * 100)}% matched)` : ''}.`
              : "What Whisper heard: the voiceover doesn't follow the script closely, so fix any typos below."}
          </p>
        )}
        {model && !model.modelReady && !task && (
          <p className={styles.note}>The first run downloads the Whisper {model.model} model (small.en is about 480 MB).</p>
        )}
        <p className={styles.device}>faster-whisper{model ? ` ${model.model}` : ''} · runs locally on CPU</p>
      </Section>

      <Section label="Style" hint="Bold, centered, word-by-word captions in the Shorts style.">
        <CaptionStyleControls />
      </Section>

      <Section label="Caption text" hint="Fix typos here. Timing stays the same. Click a time to jump to it.">
        {hasCaptions ? (
          <CaptionList />
        ) : (
          <EmptyState icon={TextCursorInput}>Captions appear here once they are generated.</EmptyState>
        )}
      </Section>
    </>
  )
}
