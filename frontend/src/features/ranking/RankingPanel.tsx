import { ChevronDown, ChevronUp, GripVertical, ListOrdered, Plus, TriangleAlert, X } from 'lucide-react'
import type { DragEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FontSelect } from '../../components/FontSelect'
import { Button } from '../../components/ui/Button'
import { Checkbox } from '../../components/ui/Checkbox'
import { EmptyState } from '../../components/ui/EmptyState'
import { ColorInput, Field, FieldRow } from '../../components/ui/Field'
import { Section } from '../../components/ui/Section'
import { Segmented } from '../../components/ui/Segmented'
import { Slider } from '../../components/ui/Slider'
import { pixels } from '../../lib/format'
import { formatTimecode } from '../../lib/time'
import { useProject } from '../../state/project/store'
import type { TimelineClip } from '../../state/project/types'
import { setUi } from '../../state/ui'
import { useLibrary } from '../library/libraryStore'
import { playback } from '../preview/playback'
import { clipEnd, sortClips } from '../timeline/clipOps'
import { orderLabel, type RankSpan, rankSpans } from './rankEntries'
import { addEntry, removeEntry, reorderEntry, setRankStyle, setRanking, updateEntry } from './rankingEdits'
import styles from './RankingPanel.module.css'

const ENTRY_DRAG_TYPE = 'application/x-shorts-rank-entry'

export function RankingPanel() {
  const ranking = useProject((p) => p.ranking)
  const clips = useProject((p) => p.clips)
  const items = useLibrary((s) => s.items)
  const spans = useMemo(() => rankSpans(ranking, clips), [ranking, clips])
  const [focusId, setFocusId] = useState<string | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const count = ranking.entries.length

  const names = useMemo(() => new Map(items.map((item) => [item.id, item.name])), [items])
  const sorted = useMemo(() => sortClips(clips), [clips])
  const clipName = (clip: TimelineClip) => names.get(clip.mediaId) ?? 'Missing clip'

  function dropIndex(event: DragEvent<HTMLLIElement>, index: number) {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY < rect.top + rect.height / 2 ? index : index + 1
  }

  function handleDrop(event: DragEvent<HTMLLIElement>, index: number) {
    event.preventDefault()
    const from = dragging
    const to = dropIndex(event, index)
    setDragging(null)
    setDropAt(null)
    // Dropping below itself means one place less once it's taken out.
    if (from !== null) reorderEntry(from, to > from ? to - 1 : to)
  }

  return (
    <>
      <Section
        label="Ranking"
        hint="For countdown videos like “Top 5 …”. Each entry shows a big rank number and its label while its clip plays."
        action={<Checkbox checked={ranking.enabled} onChange={(enabled) => setRanking({ enabled })} />}
      >
        <Segmented
          label="Order"
          options={[
            { value: 'down', label: orderLabel('down', count) },
            { value: 'up', label: orderLabel('up', count) },
          ]}
          value={ranking.direction}
          onChange={(direction) => setRanking({ direction })}
        />
      </Section>

      <fieldset className={styles.fieldset} disabled={!ranking.enabled}>
        <Section label="Entries" hint="In the order they play. Drag to reorder. Each entry shows over the clip you pick.">
          {count === 0 ? (
            <EmptyState icon={ListOrdered}>
              No entries yet. Add one per item in your ranking: select its clip on the timeline, then click Add entry.
            </EmptyState>
          ) : (
            <ol className={styles.list} aria-label="Ranking entries">
              {spans.map((span) => (
                <EntryRow
                  key={span.entry.id}
                  span={span}
                  count={count}
                  clips={sorted}
                  clipName={clipName}
                  usedBy={(clipId) => spans.find((s) => s.entry.clipId === clipId && s.entry.id !== span.entry.id)?.rank ?? null}
                  focus={focusId === span.entry.id}
                  dragging={dragging === span.index}
                  dropLine={dropAt === span.index ? 'above' : dropAt === span.index + 1 && span.index === count - 1 ? 'below' : null}
                  onDragStart={() => setDragging(span.index)}
                  onDragEnd={() => {
                    setDragging(null)
                    setDropAt(null)
                  }}
                  onDragOver={(event) => {
                    if (dragging === null) return
                    event.preventDefault()
                    setDropAt(dropIndex(event, span.index))
                  }}
                  onDrop={(event) => handleDrop(event, span.index)}
                />
              ))}
            </ol>
          )}
          <Button block icon={Plus} onClick={() => setFocusId(addEntry())}>
            Add entry
          </Button>
        </Section>

        <Section label="Look" hint="The rank number and label are drawn at the top of the video, under the title.">
          <Field label="Font">
            {(id) => <FontSelect id={id} value={ranking.style.fontId} onChange={(fontId) => setRankStyle({ fontId })} />}
          </Field>
          <Slider
            label="Number size"
            value={ranking.style.size}
            min={100}
            max={360}
            step={2}
            format={pixels}
            onChange={(size) => setRankStyle({ size })}
          />
          <FieldRow>
            <Field label="Number color">
              {(id) => (
                <ColorInput id={id} value={ranking.style.numberColor} onChange={(numberColor) => setRankStyle({ numberColor })} />
              )}
            </Field>
            <Field label="Label color">
              {(id) => (
                <ColorInput id={id} value={ranking.style.labelColor} onChange={(labelColor) => setRankStyle({ labelColor })} />
              )}
            </Field>
          </FieldRow>
        </Section>
      </fieldset>
    </>
  )
}

interface EntryRowProps {
  span: RankSpan
  count: number
  clips: readonly TimelineClip[]
  clipName: (clip: TimelineClip) => string
  /** Rank of another entry that already uses a clip. */
  usedBy: (clipId: string) => number | null
  focus: boolean
  dragging: boolean
  dropLine: 'above' | 'below' | null
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (event: DragEvent<HTMLLIElement>) => void
  onDrop: (event: DragEvent<HTMLLIElement>) => void
}

function problemText(span: RankSpan): string | null {
  switch (span.problem) {
    case 'no-clip':
      return 'Not shown yet: pick the clip it shows over.'
    case 'clip-removed':
      return 'Its clip is no longer on the timeline: pick another.'
    case 'out-of-order':
      return `#${span.rank} plays before #${span.before}: move it up, or pick a later clip.`
    default:
      return null
  }
}

function EntryRow({ span, count, clips, clipName, usedBy, focus, dragging, dropLine, ...drag }: EntryRowProps) {
  const { entry, index, rank, clip } = span
  const rowRef = useRef<HTMLLIElement>(null)
  const labelRef = useRef<HTMLInputElement>(null)
  const problem = problemText(span)

  useEffect(() => {
    if (focus) labelRef.current?.focus()
  }, [focus])

  function show() {
    if (!clip) return
    setUi({ selectedClipId: clip.id })
    playback.seek(clip.start + Math.min(0.5, clip.duration / 2))
  }

  return (
    <li
      ref={rowRef}
      className={`${styles.row} ${dragging ? styles.dragging : ''} ${dropLine ? styles[dropLine] : ''}`}
      data-testid="rank-entry"
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
    >
      <span
        className={styles.grip}
        draggable
        title="Drag to reorder"
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(ENTRY_DRAG_TYPE, entry.id)
          if (rowRef.current) event.dataTransfer.setDragImage(rowRef.current, 12, 16)
          drag.onDragStart()
        }}
        onDragEnd={drag.onDragEnd}
      >
        <GripVertical size={13} aria-hidden />
      </span>
      <button
        type="button"
        className={styles.rank}
        title={clip ? 'Show it in the preview' : undefined}
        disabled={!clip}
        onClick={show}
      >
        #{rank}
      </button>
      <div className={styles.fields}>
        <input
          ref={labelRef}
          className={styles.input}
          value={entry.label}
          maxLength={60}
          placeholder="Label, e.g. Boeing 747"
          aria-label={`Label of #${rank}`}
          onChange={(event) => updateEntry(entry.id, { label: event.target.value })}
        />
        <select
          className={`${styles.input} ${styles.select}`}
          value={entry.clipId ?? ''}
          aria-label={`Clip of #${rank}`}
          onChange={(event) => updateEntry(entry.id, { clipId: event.target.value || null })}
        >
          <option value="">Pick a clip…</option>
          {entry.clipId && !clip && <option value={entry.clipId}>Removed clip</option>}
          {clips.map((c, i) => {
            const other = usedBy(c.id)
            return (
              <option key={c.id} value={c.id} disabled={other !== null}>
                {`${i + 1}. ${formatTimecode(c.start)}–${formatTimecode(clipEnd(c))} · ${clipName(c)}${other !== null ? ` (#${other})` : ''}`}
              </option>
            )
          })}
        </select>
        {problem && (
          <p className={styles.problem}>
            <TriangleAlert size={11} aria-hidden /> {problem}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`Move #${rank} up`}
          title="Move up"
          disabled={index === 0}
          onClick={() => reorderEntry(index, index - 1)}
        >
          <ChevronUp size={13} />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`Move #${rank} down`}
          title="Move down"
          disabled={index === count - 1}
          onClick={() => reorderEntry(index, index + 1)}
        >
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`Remove #${rank}`}
          title="Remove"
          onClick={() => removeEntry(entry.id)}
        >
          <X size={13} />
        </button>
      </div>
    </li>
  )
}
