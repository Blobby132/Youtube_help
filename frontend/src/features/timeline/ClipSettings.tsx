import { Crop, Gauge, Move, Volume2, VolumeX } from 'lucide-react'
import { useId } from 'react'
import { Range } from '../../components/ui/Slider'
import { formatClipLength } from '../../lib/time'
import { useProject } from '../../state/project/store'
import { CANVAS } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { useLibrary } from '../library/libraryStore'
import { cropAxis } from '../preview/cover'
import { playback } from '../preview/playback'
import { clipEnd } from './clipOps'
import styles from './ClipSettings.module.css'
import { changeSpeed, updateClip } from './timelineEdits'

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const

const HINT = 'Or drag the picture in the preview to move the crop.'

interface ClipSettingsProps {
  /** 'card' beside the preview; 'bar' in the timeline toolbar when there's no room for the card. */
  variant: 'card' | 'bar'
}

/** Crop position, speed and audio of the selected clip. */
export function ClipSettings({ variant }: ClipSettingsProps) {
  const cropId = useId()
  const selectedId = useUi((s) => s.selectedClipId)
  const clip = useProject((p) => p.clips.find((c) => c.id === selectedId))
  const item = useLibrary((s) => (clip ? s.items.find((i) => i.id === clip.mediaId) : undefined))
  const inPreview = useUi((s) => (clip ? s.playhead >= clip.start && s.playhead < clipEnd(clip) : false))
  const card = variant === 'card'

  if (!clip) {
    return card ? (
      <aside className={styles.card} aria-label="Clip settings">
        <h3 className={styles.label}>Clip settings</h3>
        <p className={styles.hint}>Select a clip on the timeline to set its crop position, speed and audio.</p>
      </aside>
    ) : (
      <p className={styles.barHint}>Select a clip to set its crop position, speed and audio</p>
    )
  }

  const axis = item ? cropAxis(item.width, item.height, CANVAS.width, CANVAS.height) : null
  const value = axis === 'y' ? clip.cropY : clip.cropX
  const [from, to] = axis === 'y' ? ['Top', 'Bottom'] : ['Left', 'Right']
  const speeds = SPEEDS.includes(clip.speed as (typeof SPEEDS)[number]) ? SPEEDS : [...SPEEDS, clip.speed].sort((a, b) => a - b)
  const setCrop = (v: number) => updateClip(clip.id, axis === 'y' ? { cropY: v } : { cropX: v }, 'crop')

  const crop = (
    <div className={styles.group} data-testid="crop-control">
      <label className={styles.groupLabel} htmlFor={cropId}>
        <Crop size={12} aria-hidden /> {card ? 'Crop position' : 'Crop'}
      </label>
      {axis ? (
        <>
          <div className={styles.cropRow}>
            {!card && <span className={styles.end}>{from}</span>}
            <Range id={cropId} className={styles.cropRange} label="Crop position" value={value} min={0} max={1} onChange={setCrop} />
            {!card && <span className={styles.end}>{to}</span>}
          </div>
          {card && (
            <div className={styles.ends} aria-hidden>
              <span>{from}</span>
              <span>Centre</span>
              <span>{to}</span>
            </div>
          )}
          <p className={styles.hint}>
            <Move size={11} aria-hidden /> {card ? HINT : 'or drag the preview'}
          </p>
          {card && !inPreview && (
            <button type="button" className={styles.link} onClick={() => playback.seek(clip.start + Math.min(0.5, clip.duration / 2))}>
              Show this clip in the preview
            </button>
          )}
        </>
      ) : (
        <p className={styles.hint}>{item ? 'It fills the 9:16 frame exactly: nothing to crop.' : 'This clip was deleted from the library.'}</p>
      )}
    </div>
  )

  const speed = item?.kind === 'video' && (
    <div className={styles.group}>
      <label className={styles.groupLabel} title="Speed">
        <Gauge size={12} aria-hidden /> {card && 'Speed'}
        <select
          className={styles.select}
          aria-label="Clip speed"
          value={clip.speed}
          onChange={(event) => changeSpeed(clip.id, Number(event.target.value))}
        >
          {speeds.map((s) => (
            <option key={s} value={s}>
              {+s.toFixed(2)}×
            </option>
          ))}
        </select>
      </label>
    </div>
  )

  const audio = item?.kind === 'video' && (
    <div className={styles.group}>
      <div className={styles.audioRow}>
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
            className={styles.volume}
            label="Clip volume"
            value={clip.volume}
            min={0}
            max={1}
            onChange={(v) => updateClip(clip.id, { volume: v }, 'volume')}
          />
        )}
      </div>
    </div>
  )

  if (!card) {
    return (
      <div className={styles.bar} aria-label="Clip settings" title={item?.name}>
        {crop}
        {speed}
        {audio}
      </div>
    )
  }

  return (
    <aside className={styles.card} aria-label="Clip settings">
      <h3 className={styles.label}>Clip settings</h3>
      <p className={styles.name} title={item?.name}>
        {item?.name ?? 'Missing clip'}
      </p>
      {item && (
        <p className={styles.meta}>
          {item.width}×{item.height} · {formatClipLength(clip.duration)} on the timeline
        </p>
      )}
      {crop}
      {speed}
      {audio}
    </aside>
  )
}
