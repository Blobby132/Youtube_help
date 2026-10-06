// Thin fetch wrapper for the FastAPI backend. Errors carry the backend's
// `detail` message so the UI can show the real reason.
import type { MusicTrack, Project, ProjectSummary, Voiceover } from '../state/project/types'

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new ApiError('Cannot reach the backend. Is it running? Start the app with `npm run dev`.', 0)
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = await response.json()
      if (typeof body?.detail === 'string') message = body.detail
      else if (body?.detail) message = JSON.stringify(body.detail)
    } catch {
      // Vite answers 5xx with an empty body when the backend is down.
      if (response.status >= 500) message = 'The backend is not responding. Is it running?'
    }
    throw new ApiError(message, response.status)
  }
  return (await response.json()) as T
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export interface Health {
  status: 'ok'
  app: string
  version: string
  python: string
  ffmpeg: boolean
  pexels: boolean
  canvas: { width: number; height: number; fps: number }
  tts: {
    device: 'cpu' | 'directml'
    directmlAvailable: boolean
    modelReady: boolean
    /** Where Kokoro actually runs once loaded, e.g. "CPU" or "DirectML (GPU)". */
    provider: string | null
  }
}

export interface Job<T = unknown> {
  id: string
  kind: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number
  message: string
  result: T | null
  error: string | null
}

export interface Voice {
  id: string
  name: string
  accent: string
  gender: 'F' | 'M'
  description: string
}

function upload(file: Blob, fileName: string, fields: Record<string, string> = {}) {
  const form = new FormData()
  form.append('file', file, fileName)
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return { method: 'POST', body: form } satisfies RequestInit
}

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`

/** URL of a file in a project's media folder. */
export const mediaUrl = (projectId: string, file: string) =>
  `${projectPath(projectId)}/media/${encodeURIComponent(file)}`

export const voicePreviewUrl = (voiceId: string) => `/api/voices/${encodeURIComponent(voiceId)}/preview`

export const api = {
  health: () => request<Health>('/api/health'),
  voices: () => request<Voice[]>('/api/voices'),
  listProjects: () => request<ProjectSummary[]>('/api/projects'),
  getProject: (id: string) => request<unknown>(`/api/projects/${encodeURIComponent(id)}`),
  saveProject: (project: Project, init?: RequestInit) =>
    request<ProjectSummary>(projectPath(project.id), { ...json('PUT', project), ...init }),
  job: <T>(id: string) => request<Job<T>>(`/api/jobs/${encodeURIComponent(id)}`),
  startAiRead: (projectId: string, body: { text: string; voiceId: string; speed: number }) =>
    request<Job<Voiceover>>(`${projectPath(projectId)}/voiceover/ai`, json('POST', body)),
  uploadVoiceover: (projectId: string, file: Blob, fileName: string, source: 'upload' | 'recording') =>
    request<Voiceover>(`${projectPath(projectId)}/voiceover/upload`, upload(file, fileName, { source })),
  uploadMusic: (projectId: string, file: File) =>
    request<MusicTrack>(`${projectPath(projectId)}/music/upload`, upload(file, file.name)),
}
