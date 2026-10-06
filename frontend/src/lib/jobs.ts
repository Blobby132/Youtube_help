import { api, type Job } from './api'

const POLL_MS = 400

/** Polls a backend job until it finishes. Resolves with its result, rejects with its error. */
export async function waitForJob<T>(
  started: Job<T>,
  onProgress: (job: Job<T>) => void,
  signal?: AbortSignal,
): Promise<T> {
  let job = started
  onProgress(job)
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    job = await api.job<T>(job.id)
    onProgress(job)
  }
  if (job.status === 'error') throw new Error(job.error ?? 'The job failed')
  return job.result as T
}
