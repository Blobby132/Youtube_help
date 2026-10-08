import { Film, Sparkles, TriangleAlert } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { formatTimecode } from '../../lib/time'
import { useProject } from '../../state/project/store'
import type { Scene } from '../../state/project/types'
import { setUi, useUi } from '../../state/ui'
import { setScenes } from '../scenes/sceneEdits'
import { MAX_SHOT_SECONDS, resizeScene, sceneLength } from '../scenes/sceneOps'
import { laneSnapPoints, SNAP_LABEL } from './laneSnap'
import { TIMELINE_ORIGIN_PX } from './scale'
import { nearestPoint, SNAP_PIXELS, type SnapPoint } from './snap'
import styles from './Timeline.module.css'

interface Drag {
  id: string
  edge: 'start' | 'end'
  originX: number
  original: readonly Scene[]
  points: SnapPoint[]
  moved: boolean
  preview: Scene[] | null
  snap: SnapPoint | null
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3

/**
 * One block per scene. Drag an edge to change its time: it snaps to words, captions, clip edges
 * and the playhead (Alt places freely), and an edge shared with the next scene moves both (Shift
 * moves only this one, up to the neighbour). Click a scene to open it in the Scenes tab.
 */
export function ScenesLane({ pxPerSecond }: { pxPerSecond: number }) {
  const dragRef = useRef<Drag | null>(null)
  const saved = useProject((p) => p.scenes)
  const selectedId = useUi((s) => s.selectedSceneId)
  const [drag, setDrag] = useState<Drag | null>(null)
  const scenes = drag?.preview ?? saved

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

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, scene: Scene) {
    if (event.button !== 0) return
    setUi({ leftTab: 'scenes', selectedSceneId: scene.id })
    const edge = (event.target as HTMLElement).dataset.edge as 'start' | 'end' | undefined
    if (!edge) return // a click on the block: the timeline behind seeks as usual
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { id: scene.id, edge, originX: event.clientX, original: saved, points: laneSnapPoints(), moved: false, preview: null, snap: null }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = dragRef.current
    if (!current) return
    const dx = event.clientX - current.originX
    if (!current.moved && Math.abs(dx) < 3) return
    const scene = current.original.find((s) => s.id === current.id)
    if (!scene) return
    const proposed = (current.edge === 'start' ? scene.start : scene.end) + dx / pxPerSecond
    const threshold = event.altKey ? 0 : SNAP_PIXELS / pxPerSecond
    const point = nearestPoint(current.points, proposed, threshold)
    const preview = resizeScene(current.original, current.id, current.edge, point?.time ?? proposed, event.shiftKey)
    const placed = preview.find((s) => s.id === current.id)
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
    if (current?.moved && current.preview) setScenes(current.preview)
  }

  return (
    <>
      {scenes.map((scene, index) => {
        const number = index + 1
        const tooLong = scene.source === 'ai' && sceneLength(scene) > MAX_SHOT_SECONDS + 1e-3
        const when = `${formatTimecode(scene.start)}–${formatTimecode(scene.end)}`
        const classes = [
          styles.sceneBlock,
          scene.source === 'none' && styles.sceneNone,
          tooLong && styles.rankWarning,
          selectedId === scene.id && styles.sceneSelected,
          drag?.id === scene.id && styles.dragging,
        ]
        return (
          <div
            key={scene.id}
            className={classes.filter(Boolean).join(' ')}
            style={{ left: TIMELINE_ORIGIN_PX + scene.start * pxPerSecond, width: (scene.end - scene.start) * pxPerSecond }}
            title={`Scene ${number} · ${when}${tooLong ? ' · longer than 5 s' : ''} · drag an edge to change (Shift: only this scene)`}
            data-testid="scene-block"
            onPointerDown={(event) => handlePointerDown(event, scene)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => {
              dragRef.current = null
              setDrag(null)
            }}
          >
            {tooLong ? (
              <TriangleAlert size={10} aria-hidden />
            ) : scene.source === 'ai' ? (
              <Sparkles size={10} aria-hidden />
            ) : (
              scene.source === 'stock' && <Film size={10} aria-hidden />
            )}
            <span className={styles.rankText}>{number}</span>
            <span className={styles.edgeStart} data-edge="start" data-testid="scene-edge-start" aria-hidden />
            <span className={styles.edgeEnd} data-edge="end" data-testid="scene-edge-end" aria-hidden />
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
