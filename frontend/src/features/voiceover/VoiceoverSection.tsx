import { Mic, Upload, WandSparkles } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Section } from '../../components/ui/Section'
import { updateProject, useProject } from '../../state/project/store'
import { useUi } from '../../state/ui'
import { useVoices } from './useVoices'
import { VoiceList } from './VoiceList'
import styles from './VoiceoverSection.module.css'

export function VoiceoverSection() {
  const voiceId = useProject((p) => p.voiceId)
  const backend = useUi((s) => s.backend)
  const { voices, error } = useVoices()

  return (
    <Section label="Voiceover" hint="AI read, your own read, or an uploaded take.">
      <div className={styles.aiCard}>
        <div>
          <p className={styles.cardTitle}>AI read</p>
          <p className={styles.cardText}>Turns your script into a narrated voiceover in the voice you pick.</p>
        </div>
        {voices ? (
          <VoiceList
            voices={voices}
            selectedId={voiceId}
            onSelect={(id) =>
              updateProject((p) => {
                p.voiceId = id
              })
            }
          />
        ) : error ? (
          <InlineAlert>Could not load voices: {error}</InlineAlert>
        ) : (
          <p className={styles.loading}>
            {backend === 'offline' ? 'Voices load once the backend is running.' : 'Loading voices…'}
          </p>
        )}
        <Button variant="primary" block icon={WandSparkles} disabled>
          Generate AI read
        </Button>
      </div>

      <Button block icon={Mic} accentIcon disabled>
        Record your read
      </Button>
      <Button block icon={Upload} disabled>
        Upload a voiceover file
      </Button>
    </Section>
  )
}
