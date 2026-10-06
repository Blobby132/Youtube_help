import { Music } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Section } from '../../components/ui/Section'
import { Slider } from '../../components/ui/Slider'
import { percent } from '../../lib/format'
import { updateProject, useProject } from '../../state/project/store'

export function MixSection() {
  const mix = useProject((p) => p.mix)

  return (
    <Section label="Mix" hint="Balance the narration against optional background music.">
      <Slider
        label="Voiceover volume"
        value={mix.voiceVolume}
        min={0}
        max={2}
        format={percent}
        onChange={(value) =>
          updateProject((p) => {
            p.mix.voiceVolume = value
          })
        }
      />
      <Slider
        label="Music volume"
        value={mix.musicVolume}
        min={0}
        max={1}
        format={percent}
        onChange={(value) =>
          updateProject((p) => {
            p.mix.musicVolume = value
          })
        }
      />
      <Button block icon={Music} disabled>
        Add background music
      </Button>
    </Section>
  )
}
