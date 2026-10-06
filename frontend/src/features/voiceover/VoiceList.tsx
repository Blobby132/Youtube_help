import { LoaderCircle, Play, Square } from 'lucide-react'
import type { Voice } from '../../lib/api'
import type { VoicePreview } from './useVoicePreview'
import styles from './VoiceList.module.css'

interface VoiceListProps {
  voices: Voice[]
  selectedId: string
  onSelect: (id: string) => void
  preview: VoicePreview
}

export function VoiceList({ voices, selectedId, onSelect, preview }: VoiceListProps) {
  return (
    <div className={styles.list} role="radiogroup" aria-label="Voice">
      {voices.map((voice) => {
        const selected = voice.id === selectedId
        const previewing = preview.voiceId === voice.id ? preview.status : null
        return (
          <div key={voice.id} className={`${styles.card} ${selected ? styles.selected : ''}`}>
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              className={styles.select}
              onClick={() => onSelect(voice.id)}
            >
              <span className={styles.title}>
                <span className={styles.name}>{voice.name}</span>
                <span className={styles.tag}>
                  {voice.accent} · {voice.gender}
                </span>
              </span>
              <span className={styles.description}>{voice.description}</span>
            </button>
            <button
              type="button"
              className={`${styles.preview} ${previewing ? styles.previewActive : ''}`}
              aria-label={previewing ? `Stop ${voice.name} sample` : `Play a ${voice.name} sample`}
              title={previewing ? 'Stop' : `Hear ${voice.name}`}
              onClick={() => preview.toggle(voice.id)}
            >
              {previewing === 'loading' ? (
                <LoaderCircle size={12} className={styles.spin} aria-hidden />
              ) : previewing === 'playing' ? (
                <Square size={9} fill="currentColor" aria-hidden />
              ) : (
                <Play size={11} fill="currentColor" aria-hidden />
              )}
            </button>
          </div>
        )
      })}
    </div>
  )
}
