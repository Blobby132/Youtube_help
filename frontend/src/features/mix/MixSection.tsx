import { Music, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Section } from '../../components/ui/Section'
import { Slider } from '../../components/ui/Slider'
import { api } from '../../lib/api'
import { percent } from '../../lib/format'
import { formatDuration } from '../../lib/time'
import { updateProject, useProject, useProjectStore } from '../../state/project/store'
import { useUi } from '../../state/ui'
import styles from './MixSection.module.css'

const MUSIC_TYPES = '.mp3,.wav,.m4a,.aac,.ogg,.flac,audio/*'

export function MixSection() {
  const mix = useProject((p) => p.mix)
  const backend = useUi((s) => s.backend)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function addMusic(file: File) {
    const projectId = useProjectStore.getState().project.id
    setUploading(true)
    setError(null)
    try {
      const music = await api.uploadMusic(projectId, file)
      if (useProjectStore.getState().project.id === projectId) {
        updateProject((p) => {
          p.mix.music = music
        })
      }
    } catch (e) {
      console.error('Music upload failed:', e)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

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
      {mix.music ? (
        <div className={styles.music}>
          <Music size={14} className={styles.icon} aria-hidden />
          <span className={styles.name} title={mix.music.name}>
            {mix.music.name}
          </span>
          <span className={styles.duration}>{formatDuration(mix.music.duration)}</span>
          <button
            type="button"
            className={styles.remove}
            aria-label="Remove background music"
            title="Remove"
            onClick={() =>
              updateProject((p) => {
                p.mix.music = null
              })
            }
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <Button
          block
          icon={Music}
          loading={uploading}
          disabled={backend !== 'online'}
          onClick={() => fileInput.current?.click()}
        >
          {uploading ? 'Adding music…' : 'Add background music'}
        </Button>
      )}
      <input
        ref={fileInput}
        type="file"
        accept={MUSIC_TYPES}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void addMusic(file)
        }}
      />
      {error && <InlineAlert>{error}</InlineAlert>}
      {mix.music && <p className={styles.note}>Music loops under the whole video in the preview.</p>}
    </Section>
  )
}
