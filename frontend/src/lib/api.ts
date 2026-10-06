// Thin fetch wrapper for the FastAPI backend. Errors carry the backend's
// `detail` message so the UI can show the real reason.
import type { Project, ProjectSummary } from '../state/project/types'

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
}

export interface Voice {
  id: string
  name: string
  accent: string
  gender: 'F' | 'M'
  description: string
}

export const api = {
  health: () => request<Health>('/api/health'),
  voices: () => request<Voice[]>('/api/voices'),
  listProjects: () => request<ProjectSummary[]>('/api/projects'),
  getProject: (id: string) => request<unknown>(`/api/projects/${encodeURIComponent(id)}`),
  saveProject: (project: Project, init?: RequestInit) =>
    request<ProjectSummary>(`/api/projects/${encodeURIComponent(project.id)}`, {
      ...json('PUT', project),
      ...init,
    }),
}
