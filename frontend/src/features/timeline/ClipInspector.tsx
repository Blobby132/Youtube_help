import { Crop, Gauge, Volume2, VolumeX } from 'lucide-react'
import { Range } from '../../components/ui/Slider'
import { useProject } from '../../state/project/store'
import { CANVAS } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { useLibrary } from '../library/libraryStore'
import { cropAxis } from '../preview/cover'
import styles from './Timeline.module.css'
import { changeSpeed, updateClip } from './timelineEdits'

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const

/** Settings of the selected clip, shown in the timeline toolbar. */
export function ClipInspector() {
  const selectedId = useUi((s) => s.selectedClipId)
  const clip = useProject((p) => p.clips.find((c) => c.id === selectedId))
  const item = useLibrary((s) => (clip ? s.items.find((i) => i.id === clip.mediaId) : undefined))
  if (!clip) return null

  const axis = item ? cropAxis(item.width, item.height, CANVAS.width, CANVAS.height) : null
  const cropValue = axis === 'y' ? clip.cropY : clip.cropX
  const speeds = SPEEDS.includes(clip.speed as (typeof SPEEDS)[number]) ? SPEEDS : [...SPEEDS, clip.speed].sort((a, b) => a - b)

  return (
    <div className={styles.inspector} aria-label="Selected clip">
      <span className={styles.inspectorName} title={item?.name}>
        {item?.name ?? 'Missing clip'}
      </span>

      <label className={styles.inspectorField} title={axis ? 'Which part of the picture stays after cropping to 9:16 (you can also drag the preview)' : 'This clip already fills the 9:16 frame'}>
        <Crop size={12} aria-hidden />
        <span>{axis === 'y' ? 'Top–bottom' : 'Left–right'}</span>
        <Range
          className={styles.inspectorRange}
          label="Crop position"
          value={axis ? cropValue : 0.5}
          min={0}
          max={1}
          disabled={!axis}
          onChange={(value) => updateClip(clip.id, axis === 'y' ? { cropY: value } : { cropX: value }, 'crop')}
        />
      </label>

      {item?.kind === 'video' && (
        <label className={styles.inspectorField} title="Playback speed">
          <Gauge size={12} aria-hidden />
          <select
            className={styles.inspectorSelect}
            aria-label="Clip speed"
            value={clip.speed}
            onChange={(event) => changeSpeed(clip.id, Number(event.target.value))}
          >
            {speeds.map((speed) => (
              <option key={speed} value={speed}>
                {+speed.toFixed(2)}×
              </option>
            ))}
          </select>
        </label>
      )}

      {item?.kind === 'video' && (
        <div className={styles.inspectorField}>
          <button
            type="button"
            className={`${styles.audioToggle} ${clip.keepAudio ? styles.audioOn : ''}`}
            aria-pressed={clip.keepAudio}
            disabled={!item.hasAudio}
            title={
              item.hasAudio
                ? clip.keepAudio
                  ? 'Clip audio plays under the voiceover. Click to mute it.'
                  : 'Clip audio is muted. Click to keep it under the voiceover.'
                : 'This clip has no audio'
            }
            onClick={() => updateClip(clip.id, { keepAudio: !clip.keepAudio })}
          >
            {clip.keepAudio ? <Volume2 size={12} aria-hidden /> : <VolumeX size={12} aria-hidden />}
            {item.hasAudio ? (clip.keepAudio ? 'Clip audio' : 'Muted') : 'No audio'}
          </button>
          {clip.keepAudio && (
            <Range
              className={styles.inspectorRange}
              label="Clip volume"
              value={clip.volume}
              min={0}
              max={1}
              onChange={(value) => updateClip(clip.id, { volume: value }, 'volume')}
            />
          )}
        </div>
      )}
    </div>
  )
}
