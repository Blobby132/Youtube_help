import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useRef } from 'react'
import { Range } from '../../components/ui/Slider'
import { formatTimecode } from '../../lib/time'
import { projectDuration } from '../../state/project/selectors'
import { useProject } from '../../state/project/store'
import { CANVAS } from '../../state/project/types'
import { setUi, useUi } from '../../state/ui'
import { useLibrary } from '../library/libraryStore'
import { clipAt } from '../timeline/clipOps'
import { updateClip } from '../timeline/timelineEdits'
import { cropAxis } from './cover'
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
  const panRef = useRef<{ id: string; axis: 'x' | 'y'; from: number; origin: number; travel: number } | null>(null)
  usePlaybackSync()
  usePreviewRenderer(canvasRef)

  const active = useProject((p) => clipAt(p.clips, playhead))
  const item = useLibrary((s) => (active ? s.items.find((i) => i.id === active.mediaId) : undefined))
  const libraryReady = useLibrary((s) => s.status === 'ready')
  const axis = item ? cropAxis(item.width, item.height, CANVAS.width, CANVAS.height) : null
  const inGap = hasClips && !active && playhead < duration - 0.01

  const seek = (time: number) => playback.seek(time)

  /** Dragging the picture moves the crop of a clip that doesn't fill 9:16 exactly. */
  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !active || !item || !axis) return
    const rect = event.currentTarget.getBoundingClientRect()
    const zoom = Math.max(CANVAS.width / item.width, CANVAS.height / item.height)
    // How far (in screen pixels) the picture can move from one end of the crop to the other.
    const travel =
      axis === 'x'
        ? ((item.width * zoom - CANVAS.width) * rect.width) / CANVAS.width
        : ((item.height * zoom - CANVAS.height) * rect.height) / CANVAS.height
    if (travel < 1) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setUi({ selectedClipId: active.id })
    panRef.current = {
      id: active.id,
      axis,
      from: axis === 'x' ? event.clientX : event.clientY,
      origin: axis === 'x' ? active.cropX : active.cropY,
      travel,
    }
  }

  function movePan(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = panRef.current
    if (!pan) return
    const moved = (pan.axis === 'x' ? event.clientX : event.clientY) - pan.from
    // Dragging the picture right reveals more of its left side.
    const value = Math.min(1, Math.max(0, pan.origin - moved / pan.travel))
    updateClip(pan.id, pan.axis === 'x' ? { cropX: value } : { cropY: value }, 'crop')
  }

  return (
    <section className={styles.center} aria-label="Preview">
      <div className={styles.stage}>
        <div
          className={`${styles.frame} ${axis ? (axis === 'x' ? styles.panX : styles.panY) : ''}`}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={() => (panRef.current = null)}
          onPointerCancel={() => (panRef.current = null)}
          title={axis ? `Drag to choose which part of “${item?.name}” stays in the frame` : undefined}
        >
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            width={CANVAS.width}
            height={CANVAS.height}
            data-testid="preview-canvas"
          />
          {!hasClips && !hasVoiceover && (
            <p className={styles.empty}>
              Generate a voiceover, then fill the timeline with shots, uploads or imported clips.
            </p>
          )}
          {!hasClips && hasVoiceover && <p className={styles.hint}>No clips yet: add some from the Media tab</p>}
          {inGap && <p className={styles.hint}>No clip here: this part of the video is black</p>}
          {active && !item && libraryReady && (
            <p className={styles.hint}>This clip was deleted from the library</p>
          )}
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
