import { Play } from 'lucide-react'
import type { Voice } from '../../lib/api'
import styles from './VoiceList.module.css'

interface VoiceListProps {
  voices: Voice[]
  selectedId: string
  onSelect: (id: string) => void
  /** Plays a short sample of the voice; the button is disabled when absent. */
  onPreview?: (id: string) => void
}

export function VoiceList({ voices, selectedId, onSelect, onPreview }: VoiceListProps) {
  return (
    <div className={styles.list} role="radiogroup" aria-label="Voice">
      {voices.map((voice) => {
        const selected = voice.id === selectedId
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
              className={styles.preview}
              aria-label={`Preview ${voice.name}`}
              title={`Preview ${voice.name}`}
              disabled={!onPreview}
              onClick={() => onPreview?.(voice.id)}
            >
              <Play size={11} fill="currentColor" aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
}
