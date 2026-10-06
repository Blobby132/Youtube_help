import { Captions, TextCursorInput } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Checkbox } from '../../components/ui/Checkbox'
import { EmptyState } from '../../components/ui/EmptyState'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Section } from '../../components/ui/Section'
import { updateProject, useProject } from '../../state/project/store'
import { CaptionStyleControls } from './CaptionStyleControls'

export function CaptionsPanel() {
  const enabled = useProject((p) => p.captions.enabled)
  const hasVoiceover = useProject((p) => p.voiceover !== null)

  return (
    <>
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
        <Button variant="primary" block size="lg" icon={Captions} disabled>
          Generate captions
        </Button>
        {!hasVoiceover && <InlineAlert>Generate the voiceover first: caption timing is derived from it.</InlineAlert>}
      </Section>

      <Section label="Style" hint="Bold, centered, word-by-word captions in the Shorts style.">
        <CaptionStyleControls />
      </Section>

      <Section label="Caption text" hint="Fix typos here. Timing stays the same.">
        <EmptyState icon={TextCursorInput}>Captions appear here once they are generated.</EmptyState>
      </Section>
    </>
  )
}
