import { Mic, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { formatDuration } from '../../lib/time'
import { startRecording, stopRecording, useRecorder } from './recorder'
import { confirmDiscard, useVoiceoverTasks } from './voiceoverTasks'
import styles from './VoiceoverSection.module.css'

function useElapsed(startedAt: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [active])
  return active ? Math.max(0, (now - startedAt) / 1000) : 0
}

/** "Record your read" button, which turns into a recording panel with a level meter. */
export function RecordButton() {
  const status = useRecorder((s) => s.status)
  const startedAt = useRecorder((s) => s.startedAt)
  const level = useRecorder((s) => s.level)
  const task = useVoiceoverTasks((s) => s.task)
  const elapsed = useElapsed(startedAt, status === 'recording')

  if (status === 'recording') {
    return (
      <div className={styles.recorder}>
        <div className={styles.recordingRow}>
          <span className={styles.recDot} aria-hidden />
          <span className={styles.recLabel}>Recording</span>
          <span className={styles.recTime}>{formatDuration(elapsed)}</span>
          <span className={styles.meter} aria-hidden>
            <span className={styles.meterFill} style={{ width: `${Math.round(level * 100)}%` }} />
          </span>
        </div>
        <p className={styles.note}>Read your script at your own pace. Silence at the start and end is trimmed.</p>
        <div className={styles.recordActions}>
          <Button variant="primary" icon={Square} onClick={() => stopRecording(true)}>
            Stop &amp; use
          </Button>
          <Button variant="ghost" icon={X} onClick={() => stopRecording(false)}>
            Discard
          </Button>
        </div>
      </div>
    )
  }

  const processing = task?.kind === 'recording'
  return (
    <Button
      block
      icon={Mic}
      accentIcon
      loading={status === 'requesting' || processing}
      disabled={task !== null && !processing}
      onClick={() => confirmDiscard() && void startRecording()}
    >
      {status === 'requesting' ? 'Waiting for the microphone…' : processing ? task.message : 'Record your read'}
    </Button>
  )
}
