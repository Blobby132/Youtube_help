import { useEffect, useMemo, useRef, useState } from 'react'
import { newId } from '../../lib/ids'
import { formatTimecode } from '../../lib/time'
import { updateProject, useProject } from '../../state/project/store'
import { useUi } from '../../state/ui'
import { playback } from '../preview/playback'
import { type CaptionGroup, editGroupText, groupCaptions } from './captionGroups'
import styles from './CaptionList.module.css'

/** Every caption with its time; edit the text to fix typos. Click a time to jump there. */
export function CaptionList() {
  const words = useProject((p) => p.captions.words)
  const perCaption = useProject((p) => p.captions.style.wordsPerCaption)
  const groups = useMemo(() => groupCaptions(words, perCaption), [words, perCaption])
  const playhead = useUi((s) => s.playhead)
  const playing = useUi((s) => s.playing)
  const activeIndex = groups.findIndex((g) => playhead >= g.start && playhead < g.end)
  const listRef = useRef<HTMLOListElement>(null)

  // Keep the caption being spoken in view while the preview plays.
  useEffect(() => {
    if (!playing || activeIndex < 0) return
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, playing])

  return (
    <ol className={styles.list} ref={listRef}>
      {groups.map((group, index) => (
        <CaptionRow key={group.words[0].id} group={group} active={index === activeIndex} />
      ))}
    </ol>
  )
}

function CaptionRow({ group, active }: { group: CaptionGroup; active: boolean }) {
  const text = group.words.map((w) => w.text).join(' ')
  // While the field has focus it holds your draft; otherwise it shows the caption as saved.
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)

  const commit = () => {
    const edited = cancelled.current ? null : draft
    cancelled.current = false
    setDraft(null)
    if (edited === null || edited.trim() === text) return
    updateProject((p) => {
      p.captions.words = editGroupText(p.captions.words, findGroup(p.captions.words, group), edited, () => newId('w', 8))
    })
  }

  return (
    <li className={`${styles.row} ${active ? styles.active : ''}`}>
      <button type="button" className={styles.time} title="Jump here" onClick={() => playback.seek(group.start)}>
        {formatTimecode(group.start)}
      </button>
      <input
        className={styles.text}
        value={draft ?? text}
        aria-label={`Caption at ${formatTimecode(group.start)}`}
        placeholder="(removed when empty)"
        onFocus={() => setDraft(text)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            cancelled.current = true
            event.currentTarget.blur()
          }
        }}
      />
    </li>
  )
}

/** The same caption inside the Immer draft (words are matched by id, not object identity). */
function findGroup(words: CaptionGroup['words'], group: CaptionGroup): CaptionGroup {
  const ids = new Set(group.words.map((w) => w.id))
  return { ...group, words: words.filter((w) => ids.has(w.id)) }
}
