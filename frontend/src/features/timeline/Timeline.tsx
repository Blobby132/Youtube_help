import type { LucideIcon } from 'lucide-react'
import { AudioLines, Captions, Film, ListOrdered, Redo2, RefreshCw, Scissors, Trash2, Undo2 } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useRef } from 'react'
import { Button } from '../../components/ui/Button'
import { Range } from '../../components/ui/Slider'
import { formatDuration } from '../../lib/time'
import { clipsEnd, projectDuration } from '../../state/project/selectors'
import { useProject } from '../../state/project/store'
import { setUi, useUi } from '../../state/ui'
import { playback } from '../preview/playback'
import { CaptionsLane } from './CaptionsLane'
import { ClipSettings } from './ClipSettings'
import { RanksLane } from './RanksLane'
import { Ruler } from './Ruler'
import { TIMELINE_ORIGIN_PX, pixelsPerSecond } from './scale'
import styles from './Timeline.module.css'
import { deleteSelected, fitClips, redo, splitAtPlayhead, undo, useTimelineHistory } from './timelineEdits'
import { VideoLane } from './VideoLane'
import { VoiceoverLane } from './VoiceoverLane'

interface TrackInfo {
  id: 'video' | 'voiceover' | 'captions' | 'ranks'
  label: string
  icon: LucideIcon
  empty: string
}

const TRACKS: TrackInfo[] = [
  { id: 'video', label: 'Video', icon: Film, empty: '' },
  { id: 'voiceover', label: 'Voiceover', icon: AudioLines, empty: 'Generate, record or upload a voiceover' },
  { id: 'captions', label: 'Captions', icon: Captions, empty: 'Generate captions in the Captions tab' },
  { id: 'ranks', label: 'Ranks', icon: ListOrdered, empty: 'Ranking overlays from the Ranking tab' },
]

/** Seconds of empty timeline shown past the end, and the minimum visible length. */
const TAIL_SECONDS = 5
const MIN_VISIBLE_SECONDS = 30

/** Typing in a field must not trigger timeline shortcuts. */
function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]')
}

/**
 * Whether Ctrl+Z belongs to the focused field (undoing its typing) rather than the timeline.
 * Fields whose changes are on the timeline's history are marked data-undo="timeline", on them
 * or on a panel around them (the Ranking tab); data-undo="field" inside such a panel gives
 * Ctrl+Z back to that field.
 */
function fieldUndo(target: EventTarget | null) {
  return isTyping(target) && (target as HTMLElement).closest('[data-undo]')?.getAttribute('data-undo') !== 'timeline'
}

export function Timeline() {
  const clipCount = useProject((p) => p.clips.length)
  const duration = useProject(projectDuration)
  const lastClipEnd = useProject(clipsEnd)
  const hasVoiceover = useProject((p) => p.voiceover !== null)
  const hasCaptions = useProject((p) => p.captions.words.length > 0)
  const hasRanks = useProject((p) => p.ranking.entries.some((e) => e.time !== null))
  const zoom = useUi((s) => s.zoom)
  const playhead = useUi((s) => s.playhead)
  const selectedId = useUi((s) => s.selectedClipId)
  const canUndo = useTimelineHistory((s) => s.past.length > 0)
  const canRedo = useTimelineHistory((s) => s.future.length > 0)
  const notice = useTimelineHistory((s) => s.notice)
  const settingsInPreview = useUi((s) => s.clipSettingsInPreview)
  const pxPerSecond = pixelsPerSecond(zoom)
  const visibleSeconds = Math.max(Math.max(duration, lastClipEnd) + TAIL_SECONDS, MIN_VISIBLE_SECONDS)
  const contentRef = useRef<HTMLDivElement>(null)

  // Delete removes the selected clip; Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo and redo clip and
  // ranking edits.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && (key === 'z' || key === 'y')) {
        if (fieldUndo(event.target)) return
        event.preventDefault()
        if (key === 'y' || event.shiftKey) redo()
        else undo()
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && !isTyping(event.target) && useUi.getState().selectedClipId) {
        event.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function seekTo(clientX: number) {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return
    playback.seek((clientX - rect.left - TIMELINE_ORIGIN_PX) / pxPerSecond)
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    // Clicking outside a clip clears the selection.
    setUi({ selectedClipId: null })
    seekTo(event.clientX)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) seekTo(event.clientX)
  }

  return (
    <section className={styles.timeline} aria-label="Timeline">
      <header className={styles.toolbar}>
        <h2 className={styles.title}>Timeline</h2>
        <div className={styles.tools}>
          <Button
            variant="ghost"
            size="sm"
            icon={Scissors}
            disabled={!clipCount}
            title="Cut the clip at the playhead in two"
            onClick={() => splitAtPlayhead()}
            aria-label="Split"
          >
            <span className={styles.toolLabel}>Split</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={Trash2}
            disabled={!selectedId}
            title="Remove the selected clip (Delete)"
            onClick={() => deleteSelected()}
            aria-label="Delete"
          >
            <span className={styles.toolLabel}>Delete</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={RefreshCw}
            disabled={!clipCount || !hasVoiceover}
            title={
              hasVoiceover
                ? 'Close the gaps and end exactly with the voiceover, keeping your cuts'
                : 'Make a voiceover first: the video is as long as the voiceover'
            }
            onClick={() => fitClips()}
            aria-label="Fit to voiceover"
          >
            <span className={styles.toolLabel}>Fit to voiceover</span>
          </Button>
          <span className={styles.toolDivider} aria-hidden />
          <Button variant="ghost" size="sm" icon={Undo2} disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl+Z)" onClick={undo} />
          <Button variant="ghost" size="sm" icon={Redo2} disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" onClick={redo} />
        </div>
        <div className={styles.middle}>
          {notice ? (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          ) : (
            !settingsInPreview && clipCount > 0 && <ClipSettings variant="bar" />
          )}
        </div>
        <div className={styles.meta}>
          <span>
            {clipCount} {clipCount === 1 ? 'clip' : 'clips'} · {formatDuration(duration)}
          </span>
          <span className={styles.zoomLabel}>Zoom</span>
          <Range
            className={styles.zoom}
            label="Timeline zoom"
            value={zoom}
            min={0}
            max={1}
            onChange={(value) => setUi({ zoom: value })}
          />
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.heads}>
          <div className={styles.rulerSpacer} />
          {TRACKS.map(({ id, label, icon: Icon }) => (
            <div key={id} className={`${styles.head} ${styles[id]}`}>
              <Icon size={13} aria-hidden />
              {label}
            </div>
          ))}
        </div>

        <div className={styles.scroller}>
          <div
            ref={contentRef}
            className={styles.content}
            style={{ width: TIMELINE_ORIGIN_PX * 2 + visibleSeconds * pxPerSecond }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
          >
            <Ruler pxPerSecond={pxPerSecond} length={visibleSeconds} />
            {TRACKS.map(({ id, empty }) => (
              <div key={id} className={`${styles.track} ${styles[id]}`}>
                {id === 'video' ? (
                  <VideoLane pxPerSecond={pxPerSecond} />
                ) : id === 'voiceover' && hasVoiceover ? (
                  <VoiceoverLane pxPerSecond={pxPerSecond} />
                ) : id === 'captions' && hasCaptions ? (
                  <CaptionsLane pxPerSecond={pxPerSecond} />
                ) : id === 'ranks' && hasRanks ? (
                  <RanksLane pxPerSecond={pxPerSecond} />
                ) : (
                  <span className={styles.trackEmpty}>{empty}</span>
                )}
              </div>
            ))}
            <div className={styles.playhead} style={{ left: TIMELINE_ORIGIN_PX + playhead * pxPerSecond }} aria-hidden />
          </div>
        </div>
      </div>
    </section>
  )
}
