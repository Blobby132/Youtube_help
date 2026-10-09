import { CircleCheck, CircleX, PenLine, RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { ProgressBar } from '../../components/ui/ProgressBar'
import { Section } from '../../components/ui/Section'
import type { LlmStatus } from '../../lib/api'
import { useProject } from '../../state/project/store'
import { useUi } from '../../state/ui'
import generateStyles from '../generate/Generate.module.css'
import { useGenerate } from '../generate/generateStore'
import { AiReviewDialog } from './AiReviewDialog'
import { checkLlm, comfyJobsActive, llmBlocker, openReview, useLlm, writeScenesWithAi, type Failure } from './llmStore'
import styles from './Scenes.module.css'

const STATUS_MS = 10_000

/** What the model wrote, for when its answer couldn't be used. */
export function RawOutput({ failure }: { failure: Failure }) {
  if (!failure.raw.length) return null
  const count = failure.raw.length
  return (
    <details className={styles.raw} data-testid="llm-raw">
      <summary>What the model wrote ({count === 1 ? 'its answer' : `${count} answers`})</summary>
      {failure.raw.map((text, i) => (
        <pre key={i}>
          {count > 1 && <span className={styles.rawLabel}>{i === 0 ? 'First answer' : 'After being asked again'}</span>}
          {text || '(nothing)'}
        </pre>
      ))}
    </details>
  )
}

/** "Language model connected · qwen/qwen3-8b · LM Studio", like ComfyUI's status line. */
function StatusLine({ status, checking }: { status: LlmStatus | null; checking: boolean }) {
  return (
    <div className={generateStyles.status} data-testid="llm-status">
      {status?.reachable ? (
        <>
          <CircleCheck size={13} className={generateStyles.ok} aria-hidden />
          <span>
            Language model connected{status.model ? ` · ${status.model}` : ''}
            {status.serverName ? ` · ${status.serverName}` : ''}
          </span>
        </>
      ) : status ? (
        <>
          <CircleX size={13} className={generateStyles.off} aria-hidden />
          <span>Language model isn’t running</span>
        </>
      ) : (
        <span>Checking the language model…</span>
      )}
      <button
        type="button"
        className={generateStyles.recheck}
        onClick={() => void checkLlm()}
        disabled={checking}
        aria-label="Check the language model again"
        title="Check again"
      >
        <RefreshCw size={11} className={checking ? generateStyles.spin : undefined} />
      </button>
    </div>
  )
}

/** How the run shares the GPU with ComfyUI, in one line. */
function gpuNote(status: LlmStatus | null): string {
  const server = status?.serverName ?? 'the language model server'
  const after = status?.canUnload
    ? `and ${server} to unload the model afterwards`
    : status?.reachable
      ? `but ${server} can’t be asked to unload the model afterwards, so it stays loaded until the server unloads it`
      : 'and the model is unloaded afterwards where the server allows it'
  return `It only runs while ComfyUI is idle, because they share the GPU: ComfyUI is asked to unload its models first, ${after}.`
}

/** The Scenes tab's "Write with AI": a language model on this PC writes the scenes' texts. */
export function AiWriteSection() {
  const { status, checking, run, pending, reviewOpen, done, failure } = useLlm()
  const hasScenes = useProject((p) => p.scenes.length > 0)
  const online = useUi((s) => s.backend === 'online')
  const comfyJobs = useGenerate((s) => comfyJobsActive(s.jobs))
  const blocker = llmBlocker(status, online, comfyJobs)
  const writing = run?.kind === 'scenes'

  // Whether the server answers, and what ComfyUI is doing, while the Scenes tab is showing.
  useEffect(() => {
    if (!online) return
    void checkLlm()
    const timer = setInterval(() => void checkLlm(), STATUS_MS)
    return () => clearInterval(timer)
  }, [online])

  const title = !hasScenes
    ? 'Create scenes from the script first'
    : (blocker ?? (run ? 'The language model is busy' : pending ? 'Answer or discard the waiting suggestions first' : 'Fill in every scene with the language model'))

  return (
    <Section
      label="Write with AI"
      hint={
        <>
          A language model on this PC (LM Studio or Ollama) suggests each scene’s source, visual description, stock search text and ComfyUI prompt,
          writing prompts by <code>prompts/ltx_guide.md</code>. It may suggest merging or splitting scenes. Fields you’ve edited are kept unless
          you choose its text.
        </>
      }
    >
      <StatusLine status={status} checking={checking} />
      <Button
        block
        icon={PenLine}
        accentIcon
        loading={writing}
        disabled={!hasScenes || blocker !== null || run !== null || pending !== null}
        title={title}
        onClick={() => void writeScenesWithAi()}
      >
        Write scenes with AI
      </Button>
      {writing && (
        <div className={styles.aiRun} data-testid="llm-progress">
          <ProgressBar value={run.progress} label="Writing progress" />
          <span>{run.message}</span>
        </div>
      )}
      <p className={styles.note}>{gpuNote(status)}</p>

      {status && blocker && !run && (
        <InlineAlert tone={status.reachable && (status.modelProblem || status.guideProblem) ? 'warning' : 'info'}>
          <p>{blocker}</p>
          {!status.reachable && status.error && <p className={generateStyles.detail}>{status.error}</p>}
        </InlineAlert>
      )}
      {status?.reachable && status.modelWarning && <InlineAlert tone="warning">{status.modelWarning}</InlineAlert>}

      {pending && !reviewOpen && (
        <div className={styles.waiting} data-testid="llm-waiting">
          <span>The language model’s scenes are waiting for your answers.</span>
          <button type="button" className={`${styles.small} ${styles.use}`} onClick={openReview}>
            Review
          </button>
        </div>
      )}
      {done && (
        <InlineAlert tone="info">
          <p data-testid="llm-done">{done.message}</p>
          {done.skipped.length > 0 && (
            <ul className={styles.skipped} aria-label="Left out">
              {done.skipped.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          )}
          {done.notes.length > 0 && <p className={generateStyles.detail}>{done.notes.join(' ')}</p>}
        </InlineAlert>
      )}
      {failure && (
        <InlineAlert>
          <p data-testid="llm-failure">{failure.message}</p>
          <RawOutput failure={failure} />
        </InlineAlert>
      )}
      <AiReviewDialog />
    </Section>
  )
}
