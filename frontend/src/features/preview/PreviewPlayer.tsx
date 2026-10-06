import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { useRef } from 'react'
import { Range } from '../../components/ui/Slider'
import { formatTimecode } from '../../lib/time'
import { projectDuration } from '../../state/project/selectors'
import { useProject } from '../../state/project/store'
import { CANVAS } from '../../state/project/types'
import { setUi, useUi } from '../../state/ui'
import { playback } from './playback'
import styles from './PreviewPlayer.module.css'
import { usePlaybackSync } from './usePlaybackSync'
import { usePreviewRenderer } from './usePreviewRenderer'

export function PreviewPlayer() {
  const duration = useProject(projectDuration)
  const hasClips = useProject((p) => p.clips.length > 0)
  const hasVoiceover = useProject((p) => p.voiceover !== null)
  const playhead = useUi((s) => s.playhead)
  const playing = useUi((s) => s.playing)
  const volume = useUi((s) => s.volume)
  const muted = useUi((s) => s.muted)
  const canPlay = duration > 0
  const canvasRef = useRef<HTMLCanvasElement>(null)
  usePlaybackSync()
  usePreviewRenderer(canvasRef)

  const seek = (time: number) => playback.seek(time)

  return (
    <section className={styles.center} aria-label="Preview">
      <div className={styles.stage}>
        <div className={styles.frame}>
          <canvas ref={canvasRef} className={styles.canvas} width={CANVAS.width} height={CANVAS.height} />
          {!hasClips && !hasVoiceover && (
            <p className={styles.empty}>
              Generate a voiceover, then fill the timeline with shots, uploads or imported clips.
            </p>
          )}
          {!hasClips && hasVoiceover && <p className={styles.hint}>No clips yet: add some from the Media tab</p>}
        </div>

        <div className={styles.controlsArea}>
          <Range
            className={styles.scrubber}
            label="Seek"
            value={playhead}
            min={0}
            max={Math.max(duration, 0.01)}
            step={0.01}
            disabled={!canPlay}
            onChange={seek}
          />
          <div className={styles.controls}>
            <span className={styles.time}>{formatTimecode(playhead)}</span>
            <div className={styles.transport}>
              <button
                type="button"
                className={styles.iconButton}
                aria-label="Back to start"
                disabled={!canPlay}
                onClick={() => seek(0)}
              >
                <SkipBack size={15} fill="currentColor" />
              </button>
              <button
                type="button"
                className={styles.play}
                aria-label={playing ? 'Pause' : 'Play'}
                disabled={!canPlay}
                onClick={() => playback.toggle()}
              >
                {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
              </button>
              <button
                type="button"
                className={styles.iconButton}
                aria-label="Skip to end"
                disabled={!canPlay}
                onClick={() => seek(duration)}
              >
                <SkipForward size={15} fill="currentColor" />
              </button>
            </div>
            <div className={styles.volume}>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={muted ? 'Unmute' : 'Mute'}
                onClick={() => setUi({ muted: !muted })}
              >
                {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
              </button>
              <Range
                className={styles.volumeRange}
                label="Preview volume"
                value={muted ? 0 : volume}
                min={0}
                max={1}
                onChange={(value) => setUi({ volume: value, muted: false })}
              />
              <span className={styles.time}>{formatTimecode(duration)}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
