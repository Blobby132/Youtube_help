import { WandSparkles } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { ProgressBar } from '../../components/ui/ProgressBar'
import { Slider } from '../../components/ui/Slider'
import { updateProject, useProject } from '../../state/project/store'
import { useUi } from '../../state/ui'
import { useVoicePreview } from './useVoicePreview'
import { useVoices } from './useVoices'
import { generateAiRead, useVoiceoverTasks } from './voiceoverTasks'
import { VoiceList } from './VoiceList'
import styles from './VoiceoverSection.module.css'

export function AiReadCard() {
  const voiceId = useProject((p) => p.voiceId)
  const speed = useProject((p) => p.voiceSpeed)
  const hasScript = useProject((p) => p.script.trim().length > 0)
  const hasAiRead = useProject((p) => p.voiceover?.source === 'ai')
  const backend = useUi((s) => s.backend)
  const tts = useUi((s) => s.health?.tts)
  const task = useVoiceoverTasks((s) => s.task)
  const error = useVoiceoverTasks((s) => (s.error?.kind === 'ai' ? s.error.message : null))
  const { voices, error: voicesError } = useVoices()
  const preview = useVoicePreview()
  const running = task?.kind === 'ai'

  const device = tts?.provider ?? (tts?.device === 'directml' ? 'DirectML (GPU)' : 'CPU')

  return (
    <div className={styles.aiCard}>
      <div>
        <p className={styles.cardTitle}>AI read</p>
        <p className={styles.cardText}>Turns your script into a narrated voiceover in the voice you pick.</p>
      </div>
      {voices ? (
        <VoiceList
          voices={voices}
          selectedId={voiceId}
          preview={preview}
          onSelect={(id) =>
            updateProject((p) => {
              p.voiceId = id
            })
          }
        />
      ) : voicesError ? (
        <InlineAlert>Could not load voices: {voicesError}</InlineAlert>
      ) : (
        <p className={styles.loading}>
          {backend === 'offline' ? 'Voices load once the backend is running.' : 'Loading voices…'}
        </p>
      )}
      {preview.error && <InlineAlert>{preview.error}</InlineAlert>}

      <Slider
        label="Speed"
        value={speed}
        min={0.7}
        max={1.4}
        step={0.05}
        format={(value) => `${value.toFixed(2)}×`}
        onChange={(value) =>
          updateProject((p) => {
            p.voiceSpeed = value
          })
        }
      />

      <Button
        variant="primary"
        block
        icon={WandSparkles}
        loading={running}
        disabled={!hasScript || backend !== 'online' || (task !== null && !running)}
        title={hasScript ? undefined : 'Write a script first'}
        onClick={() => void generateAiRead()}
      >
        {running
          ? `Generating… ${Math.round((task?.progress ?? 0) * 100)}%`
          : hasAiRead
            ? 'Regenerate AI read'
            : 'Generate AI read'}
      </Button>
      {running && (
        <div className={styles.progress}>
          <ProgressBar value={task.progress} label="AI read progress" />
          <p className={styles.progressText}>{task.message}</p>
        </div>
      )}
      {error && <InlineAlert>{error}</InlineAlert>}
      {tts && !tts.modelReady && !running && (
        <p className={styles.note}>The first read downloads the Kokoro model (about 350 MB).</p>
      )}
      {tts?.device === 'directml' && !tts.directmlAvailable && (
        <InlineAlert tone="info">
          TTS_DEVICE is set to directml, but the DirectML runtime isn't installed, so Kokoro runs on the CPU. Run{' '}
          <code>npm run setup</code> to install it.
        </InlineAlert>
      )}
      <p className={styles.device}>Kokoro · runs locally on {device}</p>
    </div>
  )
}
