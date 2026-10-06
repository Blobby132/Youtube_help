import { useMemo } from 'react'
import { useProject } from '../../state/project/store'
import { displayWord, groupCaptions } from '../captions/captionGroups'
import { TIMELINE_ORIGIN_PX } from './scale'
import styles from './Timeline.module.css'

/** One block per caption, as they will appear on screen. */
export function CaptionsLane({ pxPerSecond }: { pxPerSecond: number }) {
  const words = useProject((p) => p.captions.words)
  const style = useProject((p) => p.captions.style)
  const enabled = useProject((p) => p.captions.enabled)
  const groups = useMemo(() => groupCaptions(words, style.wordsPerCaption), [words, style.wordsPerCaption])

  return (
    <>
      {groups.map((group) => {
        const text = group.words.map((w) => displayWord(w.text, style.uppercase)).join(' ')
        return (
          <div
            key={group.words[0].id}
            className={`${styles.captionBlock} ${enabled ? '' : styles.captionOff}`}
            style={{ left: TIMELINE_ORIGIN_PX + group.start * pxPerSecond, width: (group.end - group.start) * pxPerSecond }}
            title={text}
          >
            {text}
          </div>
        )
      })}
    </>
  )
}
