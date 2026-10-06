import { Waveform } from '../../components/ui/Waveform'
import { mediaUrl } from '../../lib/api'
import { usePeaks } from '../../lib/audio'
import { useProject } from '../../state/project/store'
import { TIMELINE_ORIGIN_PX } from './scale'
import styles from './Timeline.module.css'

/** The voiceover as one block with its waveform, on the voiceover track. */
export function VoiceoverLane({ pxPerSecond }: { pxPerSecond: number }) {
  const projectId = useProject((p) => p.id)
  const voiceover = useProject((p) => p.voiceover)
  const peaks = usePeaks(voiceover ? mediaUrl(projectId, voiceover.file) : null)
  if (!voiceover) return null
  return (
    <div
      className={styles.audioBlock}
      style={{ left: TIMELINE_ORIGIN_PX, width: voiceover.duration * pxPerSecond }}
      title="Voiceover"
    >
      <Waveform className={styles.wave} peaks={peaks} barSpacing={2} label="Voiceover waveform" />
    </div>
  )
}
