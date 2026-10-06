import { Section } from '../../components/ui/Section'
import { formatDuration } from '../../lib/time'
import { updateProject, useProject } from '../../state/project/store'
import { SCRIPT_MAX_CHARS } from '../../state/project/types'
import { countWords, estimateSpokenSeconds } from './scriptStats'
import styles from './ScriptSection.module.css'

export function ScriptSection() {
  const script = useProject((p) => p.script)
  const words = countWords(script)

  return (
    <Section label="Script" hint="The word-for-word narration. Captions and clip timing derive from it.">
      <textarea
        className={styles.textarea}
        value={script}
        maxLength={SCRIPT_MAX_CHARS}
        placeholder={'Every airplane window has a tiny hole in it.\nAnd it is not a manufacturing mistake.'}
        aria-label="Script"
        onChange={(event) =>
          updateProject((p) => {
            p.script = event.target.value
          })
        }
      />
      <p className={styles.counter}>
        {words} {words === 1 ? 'word' : 'words'} · ~{formatDuration(estimateSpokenSeconds(words))} spoken ·{' '}
        <span className={script.length >= SCRIPT_MAX_CHARS ? styles.limit : undefined}>
          {script.length}/{SCRIPT_MAX_CHARS}
        </span>
      </p>
    </Section>
  )
}
