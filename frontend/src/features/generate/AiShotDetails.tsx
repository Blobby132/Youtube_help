import { Check, Copy, RefreshCw, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { LibraryItem } from '../../lib/api'
import { useUi } from '../../state/ui'
import styles from './AiShotDetails.module.css'
import { generateBlocker, generateShots, useGenerate } from './generateStore'

const QUALITY_LABEL = { draft: 'Draft', final: 'Final' } as const

/** On an AI clip's library card: its prompt, and making more like it. */
export function AiShotDetails({ item }: { item: LibraryItem }) {
  const generation = item.generation!
  const status = useGenerate((s) => s.status)
  const online = useUi((s) => s.backend === 'online')
  const blocker = generateBlocker(status, online)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState<'again' | 'final' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(generation.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setResult({ ok: false, text: 'Could not copy: the browser blocked the clipboard.' })
    }
  }

  async function queue(kind: 'again' | 'final') {
    setBusy(kind)
    setResult(null)
    try {
      await generateShots({
        prompt: generation.prompt,
        duration: generation.duration,
        quality: kind === 'final' ? 'final' : generation.quality,
        variations: 1,
        // "Final quality" keeps the seed; "Generate again" gets a new one.
        ...(kind === 'final' ? { seed: generation.seed } : {}),
        basedOn: item.id,
      })
      setResult({ ok: true, text: kind === 'final' ? 'Final quality queued.' : 'Queued with a new seed.' })
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={styles.details} data-testid="ai-shot">
      <p className={styles.prompt} title={generation.prompt}>
        {generation.prompt}
      </p>
      <p className={styles.meta}>
        {QUALITY_LABEL[generation.quality] ?? generation.quality} · {generation.resolution.replace('x', '×')} · seed {generation.seed}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.action} onClick={() => void copy()}>
          {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={blocker !== null || busy !== null}
          title={blocker ?? 'Same prompt and settings, new seed'}
          onClick={() => void queue('again')}
        >
          <RefreshCw size={11} aria-hidden /> Generate again
        </button>
        {generation.quality === 'draft' && (
          <button
            type="button"
            className={styles.action}
            disabled={blocker !== null || busy !== null}
            title={blocker ?? 'Same prompt and seed at 0.8 megapixels'}
            onClick={() => void queue('final')}
          >
            <Sparkles size={11} aria-hidden /> Final quality
          </button>
        )}
      </div>
      {generation.quality === 'draft' && (
        <p className={styles.note}>
          Final quality uses the same prompt and seed, but the result won't match this draft exactly: a different
          resolution changes the video even with the same seed.
        </p>
      )}
      {result && <p className={result.ok ? styles.ok : styles.error}>{result.text}</p>}
    </div>
  )
}
