import { Check, CircleX, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ProgressBar } from '../../components/ui/ProgressBar'
import type { ShotJob } from '../../lib/api'
import { formatDuration } from '../../lib/time'
import styles from './Generate.module.css'
import { cancelShot, clearFinishedShots, dismissShot, isActive, useGenerate } from './generateStore'

const QUALITY_LABEL = { draft: 'Draft', final: 'Final' } as const

/** Ticks once a second while something is running, for the elapsed times. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** The shots being made (and recently made), newest first. */
export function ShotJobs() {
  const jobs = useGenerate((s) => s.jobs)
  const now = useNow(jobs.some((j) => j.status === 'running'))
  if (!jobs.length) return null
  const finished = jobs.filter((j) => !isActive(j)).length

  return (
    <div className={styles.jobs}>
      <div className={styles.jobsHeader}>
        <span className={styles.fieldLabel}>Shots</span>
        {finished > 0 && (
          <button type="button" className={styles.link} onClick={() => void clearFinishedShots()}>
            Clear finished
          </button>
        )}
      </div>
      <ul className={styles.jobList} aria-label="Shots being generated">
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} now={now} />
        ))}
      </ul>
    </div>
  )
}

function JobRow({ job, now }: { job: ShotJob; now: number }) {
  const active = isActive(job)
  const elapsed = job.startedAt ? (now - Date.parse(job.startedAt)) / 1000 : 0
  return (
    <li className={styles.job} data-status={job.status} data-testid="shot-job">
      <div className={styles.jobTop}>
        <span className={styles.jobPrompt} title={job.prompt}>
          {job.prompt}
        </span>
        {active && job.status !== 'saving' ? (
          <button type="button" className={styles.jobButton} onClick={() => void cancelShot(job.id)}>
            Cancel
          </button>
        ) : (
          !active && (
            <button type="button" className={styles.jobIcon} aria-label="Remove from the list" onClick={() => void dismissShot(job.id)}>
              <X size={12} />
            </button>
          )
        )}
      </div>
      <p className={styles.jobMeta}>
        {job.variations > 1 && `Variation ${job.variation} of ${job.variations} · `}
        {QUALITY_LABEL[job.quality]} · {job.duration} s · seed {job.seed}
      </p>
      {job.status === 'queued' && (
        <p className={styles.jobState}>{job.message || 'Waiting in ComfyUI’s queue…'}</p>
      )}
      {(job.status === 'running' || job.status === 'saving') && (
        <>
          <ProgressBar value={job.progress} label={`Shot progress: ${job.message}`} />
          <p className={styles.jobState}>
            {job.message || 'Working…'}
            {job.status === 'running' && job.startedAt && <span className={styles.elapsed}> · {formatDuration(elapsed)}</span>}
          </p>
        </>
      )}
      {job.status === 'done' && (
        <p className={`${styles.jobState} ${styles.done}`}>
          <Check size={12} aria-hidden /> Added to the library
        </p>
      )}
      {job.status === 'cancelled' && <p className={styles.jobState}>Cancelled</p>}
      {job.status === 'error' && (
        <p className={`${styles.jobState} ${styles.failed}`} role="alert">
          <CircleX size={12} aria-hidden /> {job.error}
        </p>
      )}
    </li>
  )
}
