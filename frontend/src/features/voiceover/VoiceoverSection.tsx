import { Upload } from 'lucide-react'
import { useRef } from 'react'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Section } from '../../components/ui/Section'
import { useProject } from '../../state/project/store'
import { useUi } from '../../state/ui'
import { AiReadCard } from './AiReadCard'
import { RecordButton } from './RecordButton'
import { useRecorder } from './recorder'
import { VoiceoverCard } from './VoiceoverCard'
import { confirmDiscard, importVoiceover, useVoiceoverTasks } from './voiceoverTasks'

const UPLOAD_TYPES = '.mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a'

export function VoiceoverSection() {
  const voiceover = useProject((p) => p.voiceover)
  const backend = useUi((s) => s.backend)
  const task = useVoiceoverTasks((s) => s.task)
  const error = useVoiceoverTasks((s) => s.error)
  const recorderError = useRecorder((s) => s.error)
  const fileInput = useRef<HTMLInputElement>(null)
  const uploading = task?.kind === 'upload'

  return (
    <Section label="Voiceover" hint="AI read, your own read, or an uploaded take.">
      {voiceover && <VoiceoverCard voiceover={voiceover} />}
      <AiReadCard />

      <RecordButton />
      {(recorderError || error?.kind === 'recording') && (
        <InlineAlert>{recorderError ?? error?.message}</InlineAlert>
      )}

      <Button
        block
        icon={Upload}
        loading={uploading}
        disabled={backend !== 'online' || (task !== null && !uploading)}
        onClick={() => confirmDiscard() && fileInput.current?.click()}
      >
        {uploading ? task.message : 'Upload a voiceover file'}
      </Button>
      <input
        ref={fileInput}
        type="file"
        accept={UPLOAD_TYPES}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void importVoiceover(file, file.name, 'upload')
        }}
      />
      {error?.kind === 'upload' && <InlineAlert>{error.message}</InlineAlert>}
    </Section>
  )
}
