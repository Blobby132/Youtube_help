import { ChevronDown, ChevronUp, Crosshair, GripVertical, ListOrdered, Plus, TriangleAlert, X } from 'lucide-react'
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
import { useProject } from '../../state/project/store'
import { playback } from '../preview/playback'
import { orderLabel, type RankSpan, rankSpans } from './rankEntries'
import { addEntry, removeEntry, reorderEntry, retimeEntry, setEntryTime, setRankStyle, setRanking, updateEntry } from './rankingEdits'
import styles from './RankingPanel.module.css'
import { TimeField } from './TimeField'

const ENTRY_DRAG_TYPE = 'application/x-shorts-rank-entry'

export function RankingPanel() {
  const ranking = useProject((p) => p.ranking)
  const spans = useMemo(() => rankSpans(ranking), [ranking])
  const [focusId, setFocusId] = useState<string | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const count = ranking.entries.length

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

  // Every change here is on the timeline's undo history, so Ctrl+Z undoes it even from a field.
  return (
    <div className={styles.panel} data-undo="timeline">
      <Section
        label="Ranking"
        hint="For countdown videos like “Top 5 …”. Each entry shows a big rank number and its label for its own stretch of the video."
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
        <Section
          label="Entries"
          hint="In the order they play. Drag to reorder. Type an entry’s start and end (Enter applies, Escape cancels), or drag its edges on the Ranks lane."
        >
          {count === 0 ? (
            <EmptyState icon={ListOrdered}>
              No entries yet. Add one per item in your ranking: select its clip on the timeline, or put the playhead in its sentence, then click Add entry.
            </EmptyState>
          ) : (
            <ol className={styles.list} aria-label="Ranking entries">
              {spans.map((span) => (
                <EntryRow
                  key={span.entry.id}
                  span={span}
                  count={count}
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
            onChange={(size) => setRankStyle({ size }, 'size')}
          />
          <FieldRow>
            <Field label="Number color">
              {(id) => (
                <ColorInput
                  id={id}
                  value={ranking.style.numberColor}
                  onChange={(numberColor) => setRankStyle({ numberColor }, 'numberColor')}
                />
              )}
            </Field>
            <Field label="Label color">
              {(id) => (
                <ColorInput id={id} value={ranking.style.labelColor} onChange={(labelColor) => setRankStyle({ labelColor }, 'labelColor')} />
              )}
            </Field>
          </FieldRow>
        </Section>
      </fieldset>
    </div>
  )
}

interface EntryRowProps {
  span: RankSpan
  count: number
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
    case 'no-time':
      return 'Not shown yet: select a clip or put the playhead in a sentence, then click Set time.'
    case 'out-of-order':
      return `#${span.rank} plays before #${span.before}: move it up, or give it a later time.`
    default:
      return null
  }
}

function EntryRow({ span, count, focus, dragging, dropLine, ...drag }: EntryRowProps) {
  const { entry, index, rank } = span
  const { time } = entry
  const rowRef = useRef<HTMLLIElement>(null)
  const labelRef = useRef<HTMLInputElement>(null)
  const problem = problemText(span)
  // Why a typed time wasn't used; it goes once the entry's time changes.
  const [timeMessage, setTimeMessage] = useState<{ text: string; at: string } | null>(null)
  const timeKey = time ? `${time.start}-${time.end}` : ''
  const showMessage = (text: string | null) => setTimeMessage(text ? { text, at: timeKey } : null)

  useEffect(() => {
    if (focus) labelRef.current?.focus()
  }, [focus])

  function show() {
    if (time) playback.seek(time.start + Math.min(0.5, (time.end - time.start) / 2))
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
        title={time ? 'Show it in the preview' : undefined}
        disabled={!time}
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
          onChange={(event) => updateEntry(entry.id, { label: event.target.value }, 'label')}
        />
        <div className={styles.timeRow}>
          {time ? (
            <span className={styles.times} data-testid="rank-time">
              <TimeField
                label={`Start of #${rank}`}
                value={time.start}
                onApply={(text) => setEntryTime(entry.id, 'start', text)}
                onMessage={showMessage}
              />
              <span aria-hidden>–</span>
              <TimeField
                label={`End of #${rank}`}
                value={time.end}
                onApply={(text) => setEntryTime(entry.id, 'end', text)}
                onMessage={showMessage}
              />
            </span>
          ) : (
            <span className={styles.time} data-testid="rank-time">
              No time yet
            </span>
          )}
          <button
            type="button"
            className={styles.timeButton}
            aria-label={`Set the time of #${rank}`}
            title="Set time: show it over the selected clip, or the sentence under the playhead"
            onClick={() => retimeEntry(entry.id)}
          >
            <Crosshair size={11} aria-hidden />
            {/* Beside the time fields there's only room for the icon. */}
            {!time && 'Set time'}
          </button>
        </div>
        {timeMessage?.at === timeKey && (
          <p className={styles.problem} role="alert" data-testid="rank-time-message">
            <TriangleAlert size={11} aria-hidden /> {timeMessage.text}
          </p>
        )}
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
