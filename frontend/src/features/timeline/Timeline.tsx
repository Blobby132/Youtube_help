import type { LucideIcon } from 'lucide-react'
import { AudioLines, Captions, Film, ListOrdered, RefreshCw, Scissors, Trash2 } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useRef } from 'react'
import { Button } from '../../components/ui/Button'
import { Range } from '../../components/ui/Slider'
import { formatDuration } from '../../lib/time'
import { clipsDuration, projectDuration } from '../../state/project/selectors'
import { useProject } from '../../state/project/store'
import { setUi, useUi } from '../../state/ui'
import { Ruler } from './Ruler'
import { TIMELINE_ORIGIN_PX, pixelsPerSecond } from './scale'
import styles from './Timeline.module.css'

interface TrackInfo {
  id: 'video' | 'voiceover' | 'captions' | 'ranks'
  label: string
  icon: LucideIcon
  empty: string
}

const TRACKS: TrackInfo[] = [
  { id: 'video', label: 'Video', icon: Film, empty: 'Add clips from the Media tab' },
  { id: 'voiceover', label: 'Voiceover', icon: AudioLines, empty: 'Generate, record or upload a voiceover' },
  { id: 'captions', label: 'Captions', icon: Captions, empty: 'Generate captions in the Captions tab' },
  { id: 'ranks', label: 'Ranks', icon: ListOrdered, empty: 'Ranking overlays from the Ranking tab' },
]

/** Seconds of empty timeline shown past the end, and the minimum visible length. */
const TAIL_SECONDS = 5
const MIN_VISIBLE_SECONDS = 30

export function Timeline() {
  const clipCount = useProject((p) => p.clips.length)
  const trackLength = useProject(clipsDuration)
  const duration = useProject(projectDuration)
  const zoom = useUi((s) => s.zoom)
  const playhead = useUi((s) => s.playhead)
  const pxPerSecond = pixelsPerSecond(zoom)
  const visibleSeconds = Math.max(duration + TAIL_SECONDS, MIN_VISIBLE_SECONDS)
  const contentRef = useRef<HTMLDivElement>(null)

  function seekTo(clientX: number) {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return
    const time = (clientX - rect.left - TIMELINE_ORIGIN_PX) / pxPerSecond
    setUi({ playhead: Math.min(Math.max(0, time), duration) })
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
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
          <Button variant="ghost" size="sm" icon={Scissors} disabled>
            Split
          </Button>
          <Button variant="ghost" size="sm" icon={Trash2} disabled>
            Delete
          </Button>
          <Button variant="ghost" size="sm" icon={RefreshCw} disabled>
            Fit to voiceover
          </Button>
        </div>
        <div className={styles.meta}>
          <span>
            {clipCount} {clipCount === 1 ? 'clip' : 'clips'} · {formatDuration(trackLength)}
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
                <span className={styles.trackEmpty}>{empty}</span>
              </div>
            ))}
            <div className={styles.playhead} style={{ left: TIMELINE_ORIGIN_PX + playhead * pxPerSecond }} aria-hidden />
          </div>
        </div>
      </div>
    </section>
  )
}
