import { CircleCheck, CircleX, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Section } from '../../components/ui/Section'
import { useUi } from '../../state/ui'
import { GenerateDialog } from './GenerateDialog'
import styles from './Generate.module.css'
import { checkComfy, generateBlocker, useGenerate } from './generateStore'
import { ShotJobs } from './ShotJobs'

const STATUS_MS = 10_000

/** "Generate shot": AI clips from ComfyUI on this PC, saved to the library. */
export function GenerateSection() {
  const { status, checking, error } = useGenerate()
  const online = useUi((s) => s.backend === 'online')
  const [open, setOpen] = useState(false)
  const blocker = generateBlocker(status, online)

  // Check whether ComfyUI is open while the Media tab is showing.
  useEffect(() => {
    if (!online) return
    void checkComfy()
    const timer = setInterval(() => void checkComfy(), STATUS_MS)
    return () => clearInterval(timer)
  }, [online])

  return (
    <Section label="AI shots" hint="Make clips from a prompt with LTX-2.5 in ComfyUI on this PC. They go to your library.">
      <div className={styles.status} data-testid="comfy-status">
        {status?.reachable ? (
          <>
            <CircleCheck size={13} className={styles.ok} aria-hidden />
            <span>
              ComfyUI connected{status.device ? ` · ${status.device}` : ''}
              {status.version ? ` · v${status.version}` : ''}
            </span>
          </>
        ) : status ? (
          <>
            <CircleX size={13} className={styles.off} aria-hidden />
            <span>ComfyUI isn't running</span>
          </>
        ) : (
          <span>Checking ComfyUI…</span>
        )}
        <button type="button" className={styles.recheck} onClick={() => void checkComfy()} disabled={checking} aria-label="Check ComfyUI again" title="Check again">
          <RefreshCw size={11} className={checking ? styles.spin : undefined} />
        </button>
      </div>

      <Button
        block
        icon={Sparkles}
        accentIcon
        disabled={blocker !== null}
        title={blocker ?? 'Describe a shot and generate it with ComfyUI'}
        onClick={() => setOpen(true)}
      >
        Generate shot
      </Button>
      {status && blocker && (
        <InlineAlert tone={status.workflowProblem ? 'error' : 'info'}>
          <p>{blocker}</p>
          {!status.workflowProblem && status.error && <p className={styles.detail}>{status.error}</p>}
        </InlineAlert>
      )}
      {error && <InlineAlert>{error}</InlineAlert>}

      <ShotJobs />
      <GenerateDialog open={open} onClose={() => setOpen(false)} />
    </Section>
  )
}
