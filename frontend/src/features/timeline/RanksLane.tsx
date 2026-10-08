import { TriangleAlert } from 'lucide-react'
import { useMemo } from 'react'
import { useProject } from '../../state/project/store'
import { setUi } from '../../state/ui'
import { rankSpans } from '../ranking/rankEntries'
import { clipEnd } from './clipOps'
import { TIMELINE_ORIGIN_PX } from './scale'
import styles from './Timeline.module.css'

/** One block per ranking entry, over the clip it shows on. Click one to edit it in the Ranking tab. */
export function RanksLane({ pxPerSecond }: { pxPerSecond: number }) {
  const ranking = useProject((p) => p.ranking)
  const clips = useProject((p) => p.clips)
  const spans = useMemo(() => rankSpans(ranking, clips), [ranking, clips])

  return (
    <>
      {spans.map(({ entry, rank, clip, problem }) => {
        if (!clip) return null
        const text = `#${rank}${entry.label.trim() ? ` ${entry.label.trim()}` : ''}`
        const outOfOrder = problem === 'out-of-order'
        return (
          <div
            key={entry.id}
            className={`${styles.rankBlock} ${ranking.enabled ? '' : styles.captionOff} ${outOfOrder ? styles.rankWarning : ''}`}
            style={{ left: TIMELINE_ORIGIN_PX + clip.start * pxPerSecond, width: (clipEnd(clip) - clip.start) * pxPerSecond }}
            title={outOfOrder ? `${text}: plays out of order (see the Ranking tab)` : text}
            data-testid="rank-block"
            onPointerDown={() => setUi({ leftTab: 'ranking' })}
          >
            {outOfOrder && <TriangleAlert size={10} aria-hidden />}
            {text}
          </div>
        )
      })}
    </>
  )
}
