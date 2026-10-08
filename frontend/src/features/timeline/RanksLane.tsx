import { TriangleAlert } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatTimecode } from '../../lib/time'
import { projectDuration } from '../../state/project/selectors'
import { useProject, useProjectStore } from '../../state/project/store'
import type { RankEntry } from '../../state/project/types'
import { setUi, useUi } from '../../state/ui'
import { groupCaptions } from '../captions/captionGroups'
import { rankSpans, resizeEntry } from '../ranking/rankEntries'
import { setEntries } from '../ranking/rankingEdits'
import { clipEnd } from './clipOps'
import { TIMELINE_ORIGIN_PX } from './scale'
import { nearestPoint, SNAP_PIXELS, snapPoints, type SnapPoint } from './snap'
import styles from './Timeline.module.css'

interface Drag {
  id: string
  edge: 'start' | 'end'
  originX: number
  original: readonly RankEntry[]
  points: SnapPoint[]
  moved: boolean
  preview: RankEntry[] | null
  snap: SnapPoint | null
}

const SNAP_LABEL: Record<SnapPoint['kind'], string> = {
  word: 'word',
  caption: 'caption',
  clip: 'clip',
  playhead: 'playhead',
  edge: 'end',
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3

/**
 * One block per ranking entry, over its own time. Drag an edge to change when it shows (it
 * snaps to words, captions, clip edges and the playhead, and stops at the next entry). Click
 * one to edit it in the Ranking tab.
 */
export function RanksLane({ pxPerSecond }: { pxPerSecond: number }) {
  const dragRef = useRef<Drag | null>(null)
  const ranking = useProject((p) => p.ranking)
  const [drag, setDrag] = useState<Drag | null>(null)
  const preview = drag?.preview ?? null
  const spans = useMemo(() => rankSpans(preview ? { ...ranking, entries: preview } : ranking), [ranking, preview])

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

  function pointsNow(): SnapPoint[] {
    const project = useProjectStore.getState().project
    const { words, style } = project.captions
    return snapPoints({
      words,
      groups: groupCaptions(words, style.wordsPerCaption),
      clipEdges: project.clips.flatMap((c) => [c.start, clipEnd(c)]),
      playhead: useUi.getState().playhead,
      end: projectDuration(project),
    })
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, entry: RankEntry) {
    if (event.button !== 0) return
    setUi({ leftTab: 'ranking' })
    const edge = (event.target as HTMLElement).dataset.edge as 'start' | 'end' | undefined
    if (!edge) return // a click on the block: the timeline behind seeks as usual
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      id: entry.id,
      edge,
      originX: event.clientX,
      original: ranking.entries,
      points: pointsNow(),
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
    const time = current.original.find((e) => e.id === current.id)?.time
    if (!time) return
    const proposed = (current.edge === 'start' ? time.start : time.end) + dx / pxPerSecond
    const threshold = event.altKey ? 0 : SNAP_PIXELS / pxPerSecond
    const point = nearestPoint(current.points, proposed, threshold)
    const preview = resizeEntry(current.original, current.id, current.edge, point?.time ?? proposed)
    const placed = preview.find((e) => e.id === current.id)?.time
    // Only show the snap line if the edge really landed on it (it may have been stopped short).
    const landed = placed && point && near(current.edge === 'start' ? placed.start : placed.end, point.time)
    const next = { ...current, moved: true, preview, snap: landed ? point : null }
    dragRef.current = next
    setDrag(next)
  }

  function handlePointerUp() {
    const current = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (current?.moved && current.preview) setEntries(current.preview)
  }

  return (
    <>
      {spans.map(({ entry, rank, problem }) => {
        if (!entry.time) return null
        const text = `#${rank}${entry.label.trim() ? ` ${entry.label.trim()}` : ''}`
        const outOfOrder = problem === 'out-of-order'
        const when = `${formatTimecode(entry.time.start)}–${formatTimecode(entry.time.end)}`
        const classes = [
          styles.rankBlock,
          !ranking.enabled && styles.captionOff,
          outOfOrder && styles.rankWarning,
          drag?.id === entry.id && styles.dragging,
        ]
        return (
          <div
            key={entry.id}
            className={classes.filter(Boolean).join(' ')}
            style={{ left: TIMELINE_ORIGIN_PX + entry.time.start * pxPerSecond, width: (entry.time.end - entry.time.start) * pxPerSecond }}
            title={outOfOrder ? `${text}: plays out of order (see the Ranking tab)` : `${text} · ${when} · drag an edge to change`}
            data-testid="rank-block"
            onPointerDown={(event) => handlePointerDown(event, entry)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => {
              dragRef.current = null
              setDrag(null)
            }}
          >
            {outOfOrder && <TriangleAlert size={10} aria-hidden />}
            <span className={styles.rankText}>{text}</span>
            <span className={styles.edgeStart} data-edge="start" data-testid="rank-edge-start" aria-hidden />
            <span className={styles.edgeEnd} data-edge="end" data-testid="rank-edge-end" aria-hidden />
          </div>
        )
      })}
      {drag?.snap && (
        <div className={styles.snapLine} style={{ left: TIMELINE_ORIGIN_PX + drag.snap.time * pxPerSecond }} aria-hidden>
          <span>{SNAP_LABEL[drag.snap.kind]}</span>
        </div>
      )}
    </>
  )
}
