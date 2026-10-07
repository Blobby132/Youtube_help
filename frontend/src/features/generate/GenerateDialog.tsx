import { Sparkles } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Modal } from '../../components/ui/Modal'
import { Segmented } from '../../components/ui/Segmented'
import type { ShotQuality } from '../../lib/api'
import styles from './Generate.module.css'
import { generateShots } from './generateStore'

const DURATIONS = [2, 3, 4, 5].map((s) => ({ value: s, label: `${s} s` }))
const QUALITIES = [
  { value: 'draft', label: 'Draft', title: '0.4 megapixels (about 480×864): faster, for trying ideas' },
  { value: 'final', label: 'Final', title: '0.8 megapixels (about 672×1200): sharper, takes longer' },
] as const
const VARIATIONS = [1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))
const MAX_PROMPT = 4000

interface GenerateDialogProps {
  open: boolean
  onClose: () => void
}

/** Prompt, length, quality and how many variations; always 9:16 at 24 fps. */
export function GenerateDialog({ open, onClose }: GenerateDialogProps) {
  const promptId = useId()
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState(3)
  const [quality, setQuality] = useState<ShotQuality>('draft')
  const [variations, setVariations] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await generateShots({ prompt, duration, quality, variations })
      setPrompt('')
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Generate shot" open={open} onClose={onClose}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label htmlFor={promptId} className={styles.fieldLabel}>
          Prompt
        </label>
        <textarea
          id={promptId}
          className={styles.prompt}
          value={prompt}
          maxLength={MAX_PROMPT}
          rows={5}
          placeholder="A static overhead shot of a pane of glass on wet concrete, rain starting to fall, soft daylight…"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && prompt.trim()) void submit()
          }}
          autoFocus
        />
        <p className={styles.hint}>Describe the scene, the camera and the light. Ctrl+Enter generates.</p>

        <div className={styles.row}>
          <span className={styles.fieldLabel}>Length</span>
          <Segmented<number> label="Length" options={DURATIONS} value={duration} onChange={setDuration} />
        </div>
        <div className={styles.row}>
          <span className={styles.fieldLabel}>Quality</span>
          <Segmented<ShotQuality> label="Quality" options={QUALITIES} value={quality} onChange={setQuality} />
        </div>
        <p className={styles.hint}>
          {quality === 'draft' ? 'Draft: 0.4 megapixels (about 480×864), faster.' : 'Final: 0.8 megapixels (about 672×1200), sharper.'}
        </p>
        <div className={styles.row}>
          <span className={styles.fieldLabel}>Variations</span>
          <Segmented<number> label="Variations" options={VARIATIONS} value={variations} onChange={setVariations} />
        </div>
        <p className={styles.hint}>
          Each variation gets its own random seed. Always 9:16 at 24 fps. Each clip takes about 3 to 5 minutes; they're
          made one after another in the background and added to your library.
        </p>

        {error && <InlineAlert>{error}</InlineAlert>}
        <Button type="submit" variant="primary" block icon={Sparkles} loading={busy} disabled={!prompt.trim()}>
          Generate {variations > 1 ? `${variations} variations` : 'shot'}
        </Button>
      </form>
    </Modal>
  )
}
