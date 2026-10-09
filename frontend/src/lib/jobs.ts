import { api, type Job } from './api'

const POLL_MS = 400

/** A job that failed, with what came with its error (e.g. the language model's raw answers). */
export class JobError extends Error {
  readonly data: Record<string, unknown> | null
  constructor(message: string, data: Record<string, unknown> | null = null) {
    super(message)
    this.name = 'JobError'
    this.data = data
  }
}

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
  if (job.status === 'error') throw new JobError(job.error ?? 'The job failed', job.errorData ?? null)
  return job.result as T
}
