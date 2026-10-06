import { ArrowRight, LoaderCircle, Play, Plus, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Section } from '../../components/ui/Section'
import { api } from '../../lib/api'
import { useProject } from '../../state/project/store'
import { useUi } from '../../state/ui'
import {
  addPronunciation,
  editPronunciation,
  loadPronunciations,
  removePronunciation,
  savePronunciations,
  usePronunciations,
} from './pronunciationStore'
import styles from './PronunciationsSection.module.css'

const SAVE_LABEL = { idle: '', saving: 'Saving…', saved: 'Saved for all projects', error: 'Not saved' } as const

/** The app-wide list of how the AI read says particular words and symbols. */
export function PronunciationsSection() {
  const backend = useUi((s) => s.backend)
  const rows = usePronunciations((s) => s.rows)
  const status = usePronunciations((s) => s.status)
  const save = usePronunciations((s) => s.save)
  const error = usePronunciations((s) => s.error)
  const voiceId = useProject((p) => p.voiceId)
  const hearing = useHearing()

  useEffect(() => {
    if (backend === 'online') void loadPronunciations()
  }, [backend])

  const counts = new Map<string, number>()
  for (const row of rows) if (row.written.trim()) counts.set(row.written.trim(), (counts.get(row.written.trim()) ?? 0) + 1)
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([written]) => written)

  return (
    <Section
      label="Pronunciations"
      hint="How the AI read says a word or symbol, in every project. Your script and captions keep the original spelling. Regenerate the AI read to hear changes."
      action={<span className={styles.saveState} data-state={save}>{SAVE_LABEL[save]}</span>}
    >
      {status === 'loading' && backend !== 'online' && <p className={styles.note}>Loads once the backend is running.</p>}
      {rows.length > 0 && (
        <div className={styles.list}>
          <div className={styles.header} aria-hidden>
            <span>Written</span>
            <span />
            <span>Spoken</span>
          </div>
          {rows.map((row) => {
            const state = hearing.rowId === row.id ? hearing.state : null
            return (
              <div key={row.id} className={styles.row}>
                <input
                  className={styles.input}
                  value={row.written}
                  placeholder="5.0"
                  maxLength={100}
                  aria-label="Written as"
                  onChange={(event) => editPronunciation(row.id, { written: event.target.value })}
                />
                <ArrowRight size={13} className={styles.arrow} aria-hidden />
                <input
                  className={styles.input}
                  value={row.spoken}
                  placeholder="five point oh"
                  maxLength={300}
                  aria-label={`Spoken as (for ${row.written || 'this entry'})`}
                  onChange={(event) => editPronunciation(row.id, { spoken: event.target.value })}
                />
                <button
                  type="button"
                  className={`${styles.iconButton} ${state ? styles.active : ''}`}
                  title={state === 'playing' ? 'Stop' : 'Hear it'}
                  aria-label={state === 'playing' ? 'Stop' : `Hear how "${row.written}" is read`}
                  disabled={!row.written.trim() || backend !== 'online'}
                  onClick={() => hearing.toggle(row.id, row.written, voiceId)}
                >
                  {state === 'loading' ? (
                    <LoaderCircle size={12} className={styles.spin} />
                  ) : state === 'playing' ? (
                    <Square size={9} fill="currentColor" />
                  ) : (
                    <Play size={11} fill="currentColor" />
                  )}
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  title="Remove"
                  aria-label={`Remove ${row.written || 'this entry'}`}
                  onClick={() => removePronunciation(row.id)}
                >
                  <X size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <Button block icon={Plus} disabled={status !== 'ready'} onClick={addPronunciation}>
        Add pronunciation
      </Button>
      {duplicates.length > 0 && (
        <InlineAlert tone="info">
          {duplicates.map((d) => `“${d}”`).join(', ')} {duplicates.length === 1 ? 'is' : 'are'} listed more than once;
          the lowest entry is used.
        </InlineAlert>
      )}
      {(error || hearing.error) && <InlineAlert>{hearing.error ?? error}</InlineAlert>}
    </Section>
  )
}

/** Plays one entry at a time: the written text read through the saved list, as in a voiceover. */
function useHearing() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [rowId, setRowId] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'playing' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const stop = () => {
    audioRef.current?.pause()
    audioRef.current = null
    setRowId(null)
    setState(null)
  }
  useEffect(() => () => audioRef.current?.pause(), [])

  const toggle = async (id: string, text: string, voiceId: string) => {
    const same = id === rowId
    stop()
    if (same) return
    setError(null)
    setRowId(id)
    setState('loading')
    const audio = new Audio()
    audioRef.current = audio
    try {
      await savePronunciations()
      const url = URL.createObjectURL(await api.say(voiceId, text))
      if (audioRef.current !== audio) return
      audio.onplaying = () => audioRef.current === audio && setState('playing')
      audio.onended = () => {
        URL.revokeObjectURL(url)
        if (audioRef.current === audio) stop()
      }
      audio.src = url
      await audio.play()
    } catch (e) {
      if (audioRef.current !== audio) return
      stop()
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return { rowId, state, error, toggle: (id: string, text: string, voiceId: string) => void toggle(id, text, voiceId) }
}
