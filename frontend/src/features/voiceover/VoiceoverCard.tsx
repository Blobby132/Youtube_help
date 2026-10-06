import { AudioLines, Mic, Pause, Play, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Waveform } from '../../components/ui/Waveform'
import { mediaUrl } from '../../lib/api'
import { usePeaks } from '../../lib/audio'
import { formatTimecode } from '../../lib/time'
import { useProject } from '../../state/project/store'
import type { Voiceover } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { playback } from '../preview/playback'
import { useVoices } from './useVoices'
import { removeVoiceover } from './voiceoverTasks'
import styles from './VoiceoverCard.module.css'

function useTitle(voiceover: Voiceover): string {
  const { voices } = useVoices()
  if (voiceover.source === 'recording') return 'Your recording'
  if (voiceover.source === 'upload') return voiceover.name ?? 'Uploaded voiceover'
  const name = voices?.find((v) => v.id === voiceover.voiceId)?.name ?? voiceover.voiceId ?? 'AI'
  const speed = voiceover.speed && voiceover.speed !== 1 ? ` · ${voiceover.speed.toFixed(2)}×` : ''
  return `AI read · ${name}${speed}`
}

const ICONS = { ai: AudioLines, recording: Mic, upload: Upload } as const

/** The active voiceover: waveform, play/pause, remove. */
export function VoiceoverCard({ voiceover }: { voiceover: Voiceover }) {
  const projectId = useProject((p) => p.id)
  const script = useProject((p) => p.script)
  const playing = useUi((s) => s.playing)
  const playhead = useUi((s) => s.playhead)
  const peaks = usePeaks(mediaUrl(projectId, voiceover.file))
  const title = useTitle(voiceover)
  const Icon = ICONS[voiceover.source]
  const progress = voiceover.duration > 0 ? Math.min(1, playhead / voiceover.duration) : 0
  const stale = voiceover.source === 'ai' && voiceover.script !== undefined && voiceover.script !== script
  const cardRef = useRef<HTMLDivElement>(null)

  // A new take appears above the controls you just used; bring it into view.
  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [voiceover.file])

  return (
    <div className={styles.card} ref={cardRef}>
      <div className={styles.header}>
        <Icon size={14} className={styles.icon} aria-hidden />
        <span className={styles.title} title={title}>
          {title}
        </span>
        <span className={styles.duration}>{formatTimecode(voiceover.duration)}</span>
      </div>
      <div className={styles.player}>
        <button
          type="button"
          className={styles.play}
          aria-label={playing ? 'Pause voiceover' : 'Play voiceover'}
          onClick={() => playback.toggle()}
        >
          {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
        </button>
        <Waveform
          className={styles.wave}
          peaks={peaks}
          progress={progress}
          label="Voiceover waveform: click to seek"
          onSeek={(fraction) => playback.seek(fraction * voiceover.duration)}
        />
        <button type="button" className={styles.remove} aria-label="Remove voiceover" title="Remove" onClick={removeVoiceover}>
          <Trash2 size={14} />
        </button>
      </div>
      {stale && (
        <InlineAlert tone="info">The script changed after this read was made. Regenerate it so the voice matches.</InlineAlert>
      )}
    </div>
  )
}
