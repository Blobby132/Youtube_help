import { CircleAlert, Sparkles, Volume2 } from 'lucide-react'
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { libraryThumbnailUrl, type LibraryItem } from '../../lib/api'
import { formatTimecode } from '../../lib/time'
import { useProject } from '../../state/project/store'
import type { TimelineClip } from '../../state/project/types'
import { setUi, useUi } from '../../state/ui'
import { groupCaptions } from '../captions/captionGroups'
import { draggedMedia, MEDIA_DRAG_TYPE } from '../library/dragMedia'
import { useLibrary } from '../library/libraryStore'
import { playback } from '../preview/playback'
import { clipEnd, clipsEnd, findGaps, insertClip, moveClip, trimEnd, trimStart } from './clipOps'
import { TIMELINE_ORIGIN_PX } from './scale'
import { nearestPoint, SNAP_PIXELS, snapEdges, snapPoints, type SnapPoint } from './snap'
import styles from './Timeline.module.css'
import { addToTimeline, editClips, sourceLengths } from './timelineEdits'

type DragKind = 'move' | 'start' | 'end'

interface Drag {
  kind: DragKind
  id: string
  originX: number
  original: readonly TimelineClip[]
  points: SnapPoint[]
  moved: boolean
  preview: TimelineClip[] | null
  snap: SnapPoint | null
}

const DROP_ID = 'drop-preview'
const SNAP_LABEL: Record<SnapPoint['kind'], string> = {
  word: 'word',
  caption: 'caption',
  clip: 'clip',
  playhead: 'playhead',
  edge: 'end',
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3

/** The video track: clips, the gaps between them, and drag-and-drop editing. */
export function VideoLane({ pxPerSecond }: { pxPerSecond: number }) {
  const laneRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const clips = useProject((p) => p.clips)
  const voiceEnd = useProject((p) => p.voiceover?.duration ?? null)
  const words = useProject((p) => p.captions.words)
  const perCaption = useProject((p) => p.captions.style.wordsPerCaption)
  const items = useLibrary((s) => s.items)
  const libraryReady = useLibrary((s) => s.status === 'ready')
  const selectedId = useUi((s) => s.selectedClipId)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [drop, setDrop] = useState<{ clips: TimelineClip[]; item: LibraryItem; snap: SnapPoint | null } | null>(null)

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const groups = useMemo(() => groupCaptions(words, perCaption), [words, perCaption])
  const shown = drag?.preview ?? drop?.clips ?? clips
  const end = voiceEnd ?? clipsEnd(shown)
  const gaps = findGaps(shown, end, 0.05)
  const pastEnd = voiceEnd !== null && shown.some((c) => clipEnd(c) > voiceEnd + 1e-3)
  const snap = drag?.snap ?? drop?.snap ?? null

  // Escape cancels a drag.
  useEffect(() => {
    if (!drag) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      dragRef.current = null
      setDrag(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drag])

  const timeAt = (clientX: number) => {
    const rect = laneRef.current?.getBoundingClientRect()
    return rect ? (clientX - rect.left - TIMELINE_ORIGIN_PX) / pxPerSecond : 0
  }

  const pointsFor = (excludeId?: string) =>
    snapPoints({
      words,
      groups,
      clipEdges: clips.filter((c) => c.id !== excludeId).flatMap((c) => [c.start, clipEnd(c)]),
      playhead: useUi.getState().playhead,
      end: voiceEnd ?? 0,
    })

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, clip: TimelineClip) {
    if (event.button !== 0) return
    event.stopPropagation() // the timeline behind would seek
    setUi({ selectedClipId: clip.id })
    const edge = (event.target as HTMLElement).dataset.edge as 'start' | 'end' | undefined
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      kind: edge ?? 'move',
      id: clip.id,
      originX: event.clientX,
      original: clips,
      points: pointsFor(clip.id),
      moved: false,
      preview: null,
      snap: null,
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = dragRef.current
    if (!current) return
    const dx = event.clientX - current.originX
    if (!current.moved && Math.abs(dx) < 3) return
    const clip = current.original.find((c) => c.id === current.id)
    if (!clip) return
    const shift = dx / pxPerSecond
    const threshold = event.altKey ? 0 : SNAP_PIXELS / pxPerSecond
    let preview: TimelineClip[]
    let point: SnapPoint | null
    if (current.kind === 'move') {
      const snapped = snapEdges(current.points, [clip.start + shift, clipEnd(clip) + shift], threshold)
      preview = moveClip(current.original, clip.id, clip.start + shift + snapped.shift, timeAt(event.clientX))
      point = snapped.point
    } else {
      const proposed = (current.kind === 'start' ? clip.start : clipEnd(clip)) + shift
      point = nearestPoint(current.points, proposed, threshold)
      const time = point?.time ?? proposed
      preview =
        current.kind === 'start'
          ? trimStart(current.original, clip.id, time, sourceLengths())
          : trimEnd(current.original, clip.id, time, sourceLengths())
    }
    const placed = preview.find((c) => c.id === clip.id)
    // Only show the snap line if the edge really landed on it (it may have been stopped short).
    const landed = placed && point && (near(placed.start, point.time) || near(clipEnd(placed), point.time))
    const next = { ...current, moved: true, preview, snap: landed ? point : null }
    dragRef.current = next
    setDrag(next)
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const current = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!current) return
    if (current.moved && current.preview) {
      const result = current.preview
      editClips(() => result)
    } else {
      playback.seek(timeAt(event.clientX))
    }
  }

  function dropTarget(event: DragEvent<HTMLDivElement>) {
    const item = draggedMedia() ?? byId.get(event.dataTransfer.getData(MEDIA_DRAG_TYPE))
    if (!item) return null
    const time = timeAt(event.clientX)
    const point = nearestPoint(pointsFor(), time, SNAP_PIXELS / pxPerSecond)
    return { item, at: Math.max(0, point?.time ?? time), point }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    const target = dropTarget(event)
    if (!target) return
    const media = { id: target.item.id, duration: target.item.kind === 'image' ? null : target.item.duration }
    setDrop({ clips: insertClip(clips, media, target.at, voiceEnd ?? 0, DROP_ID), item: target.item, snap: target.point })
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return
    event.preventDefault()
    const target = dropTarget(event)
    setDrop(null)
    if (target) addToTimeline(target.item, target.at)
  }

  return (
    <div
      ref={laneRef}
      className={styles.videoLane}
      onDragOver={handleDragOver}
      onDragLeave={(event) => {
        if (!laneRef.current?.contains(event.relatedTarget as Node | null)) setDrop(null)
      }}
      onDrop={handleDrop}
      data-testid="video-lane"
    >
      {shown.length === 0 && gaps.length === 0 && <span className={styles.trackEmpty}>Drag clips here from the Media tab</span>}

      {gaps.map((gap) => (
        <div
          key={`gap-${gap.start}`}
          className={styles.gap}
          style={{ left: TIMELINE_ORIGIN_PX + gap.start * pxPerSecond, width: (gap.end - gap.start) * pxPerSecond }}
          title={`No clip from ${formatTimecode(gap.start)} to ${formatTimecode(gap.end)}`}
          data-testid="timeline-gap"
        >
          {(gap.end - gap.start) * pxPerSecond > 60 && (
            <span>{shown.length === 0 ? 'No clips: drag one here from the Media tab' : 'No clip'}</span>
          )}
        </div>
      ))}

      {voiceEnd !== null && (
        <div className={styles.afterEnd} style={{ left: TIMELINE_ORIGIN_PX + voiceEnd * pxPerSecond }} aria-hidden>
          {pastEnd && <span>After the voiceover: not in the video</span>}
        </div>
      )}

      {shown.map((clip) => {
        const item = byId.get(clip.mediaId)
        const isDrop = clip.id === DROP_ID
        const width = clip.duration * pxPerSecond
        const missing = !item && libraryReady && !isDrop
        const classes = [
          styles.clip,
          clip.id === selectedId && styles.selected,
          drag?.id === clip.id && styles.dragging,
          isDrop && styles.dropGhost,
          missing && styles.missing,
        ]
        const name = isDrop ? drop?.item.name : (item?.name ?? (missing ? 'Missing clip' : 'Loading…'))
        const shownItem = isDrop ? drop?.item : item
        return (
          <div
            key={clip.id}
            className={classes.filter(Boolean).join(' ')}
            style={{ left: TIMELINE_ORIGIN_PX + clip.start * pxPerSecond, width }}
            onPointerDown={isDrop ? undefined : (event) => handlePointerDown(event, clip)}
            onPointerMove={isDrop ? undefined : handlePointerMove}
            onPointerUp={isDrop ? undefined : handlePointerUp}
            onPointerCancel={() => {
              dragRef.current = null
              setDrag(null)
            }}
            title={`${name} · ${formatTimecode(clip.start)}–${formatTimecode(clipEnd(clip))}${missing ? ' · deleted from the library' : ''}`}
            data-testid={isDrop ? undefined : 'timeline-clip'}
            aria-label={isDrop ? undefined : `Clip ${name}`}
            aria-pressed={isDrop ? undefined : clip.id === selectedId}
            role={isDrop ? undefined : 'button'}
            tabIndex={isDrop ? undefined : 0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setUi({ selectedClipId: clip.id })
              }
            }}
          >
            {shownItem && (
              <div className={styles.film} style={{ backgroundImage: `url(${libraryThumbnailUrl(shownItem.id)})` }} />
            )}
            {width > 34 && (
              <div className={styles.clipInfo}>
                <span className={styles.clipName}>
                  {missing && <CircleAlert size={11} aria-hidden />}
                  {name}
                </span>
                {width > 70 && !isDrop && (
                  <span className={styles.badges}>
                    {item?.aiGenerated && (
                      <span className={styles.aiBadge} title="AI-generated">
                        <Sparkles size={9} aria-hidden />
                        AI
                      </span>
                    )}
                    {item?.lowRes && <span className={styles.lowBadge} title={`${item.width}×${item.height}: scaled up to fill the frame`}>Low res</span>}
                    {clip.speed !== 1 && <span className={styles.badge}>{+clip.speed.toFixed(2)}×</span>}
                    {clip.keepAudio && <Volume2 size={11} aria-label="Clip audio on" />}
                  </span>
                )}
              </div>
            )}
            {!isDrop && (
              <>
                <span className={styles.edgeStart} data-edge="start" aria-hidden />
                <span className={styles.edgeEnd} data-edge="end" aria-hidden />
              </>
            )}
          </div>
        )
      })}

      {snap && (
        <div className={styles.snapLine} style={{ left: TIMELINE_ORIGIN_PX + snap.time * pxPerSecond }} aria-hidden>
          <span>{SNAP_LABEL[snap.kind]}</span>
        </div>
      )}
    </div>
  )
}
