import { WandSparkles } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { ProgressBar } from '../../components/ui/ProgressBar'
import { Section } from '../../components/ui/Section'
import { useProject } from '../../state/project/store'
import { useUi } from '../../state/ui'
import styles from './MediaPanel.module.css'
import { runAutofill, useAutofill } from './autofillTasks'

export function AutofillSection() {
  const hasScript = useProject((p) => p.script.trim().length > 0)
  const hasVoiceover = useProject((p) => p.voiceover !== null)
  const pexelsReady = useUi((s) => s.health?.pexels)
  const online = useUi((s) => s.backend === 'online')
  const { task, error, summary, misses } = useAutofill()

  return (
    <Section label="Auto-fill" hint="Picks keywords from each sentence of the script and fetches a matching clip for it.">
      <Button
        block
        icon={WandSparkles}
        accentIcon
        loading={!!task}
        disabled={!hasScript || !online || pexelsReady === false}
        title={!hasScript ? 'Write a script first' : pexelsReady === false ? 'Needs a Pexels API key' : undefined}
        onClick={() => void runAutofill()}
      >
        Auto-fill from script
      </Button>
      {task && (
        <div className={styles.progress}>
          <ProgressBar value={task.progress} label="Auto-fill progress" />
          <p className={styles.note}>{task.message}</p>
        </div>
      )}
      {error && <InlineAlert>{error}</InlineAlert>}
      {summary && !task && <p className={styles.note}>{summary}</p>}
      {misses.length > 0 && !task && (
        <InlineAlert tone="warning">
          <p>
            {misses.length === 1 ? 'One sentence' : `${misses.length} sentences`} got no clip of {misses.length === 1 ? 'its' : 'their'} own; the clip
            before {misses.length === 1 ? 'it' : 'them'} runs longer:
          </p>
          <ul className={styles.misses}>
            {misses.map((miss) => (
              <li key={miss.text}>
                “{miss.text}” <span>({miss.reason})</span>
              </li>
            ))}
          </ul>
        </InlineAlert>
      )}
      {!hasVoiceover && hasScript && !task && (
        <p className={styles.note}>Without a voiceover, clip lengths are estimated from the script.</p>
      )}
    </Section>
  )
}
