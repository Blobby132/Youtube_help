// Thin fetch wrapper for the FastAPI backend. Errors carry the backend's
// `detail` message so the UI can show the real reason.
import type { CaptionWord, MusicTrack, Project, ProjectSummary, SceneTextField, SceneTexts, Voiceover } from '../state/project/types'

export class ApiError extends Error {
  readonly status: number
  /** Seconds until a rate limit resets (sent by the backend with HTTP 429). */
  readonly retryAfter: number | null
  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryAfter = retryAfter
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
    let retryAfter: number | null = null
    try {
      const body = await response.json()
      if (typeof body?.detail === 'string') message = body.detail
      else if (body?.detail) message = JSON.stringify(body.detail)
      if (typeof body?.retryAfter === 'number') retryAfter = body.retryAfter
    } catch {
      // Vite answers 5xx with an empty body when the backend is down.
      if (response.status >= 500) message = 'The backend is not responding. Is it running?'
    }
    throw new ApiError(message, response.status, retryAfter)
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
  /** Which stock video sources have an API key in .env. */
  pexels: boolean
  pixabay: boolean
  canvas: { width: number; height: number; fps: number }
  tts: {
    device: 'cpu' | 'directml'
    directmlAvailable: boolean
    modelReady: boolean
    /** Where Kokoro actually runs once loaded, e.g. "CPU" or "DirectML (GPU)". */
    provider: string | null
  }
  captions: { model: string; modelReady: boolean }
}

export interface CaptionResult {
  words: Omit<CaptionWord, 'id'>[]
  source: 'script' | 'transcript'
  /** Share of the script's letters found in what Whisper heard (null without a script). */
  matched: number | null
  model: string
  voiceoverFile: string
}

/** One pronunciation entry: Kokoro says `spoken` wherever the script has `written`. */
export interface PronunciationEntry {
  written: string
  spoken: string
}

export interface FontInfo {
  id: string
  name: string
}

export interface Job<T = unknown> {
  id: string
  kind: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number
  message: string
  result: T | null
  error: string | null
  /** Data that comes with a failure, e.g. { raw: [...] }: what the language model wrote. */
  errorData?: Record<string, unknown> | null
}

export type MediaSource = 'pexels' | 'pixabay' | 'upload' | 'ai'

/** A clip or image in the media library, which all projects share. */
export interface LibraryItem {
  id: string
  kind: 'video' | 'image'
  name: string
  file: string
  thumbnail: string | null
  width: number
  height: number
  /** Seconds; null for images. */
  duration: number | null
  fps: number | null
  hasAudio: boolean
  size: number
  /** Where it came from: a Pexels or Pixabay download, an import, or an AI shot made by the app. */
  source: MediaSource
  aiGenerated: boolean
  /** Narrower than 1080 pixels, so it's scaled up to fill the frame. */
  lowRes: boolean
  originalName: string | null
  addedAt: string
  pexels: { videoId: number; url: string; photographer: string; photographerUrl: string | null } | null
  pixabay: { videoId: number; url: string; uploader: string; uploaderUrl: string | null } | null
  /** For AI shots: how it was made. */
  generation: AiGeneration | null
  /** A scene preview's saved first pass (its final is made from it); missing on previews made
   * before finals could match them, and on everything else. */
  latents?: { video: string; audio: string } | null
}

export type ShotQuality = 'draft' | 'final'

/** How an AI shot was made (stored with the library clip). */
export interface AiGeneration {
  prompt: string
  seed: number
  quality: ShotQuality
  megapixels: number
  resolution: string
  duration: number
  fps: number
  workflow: string
  basedOn: string | null
  generatedAt: string
  /** Set on a scene's preview or final (the Scenes tab): which project and scene, and the job that made it. */
  type?: 'preview' | 'final'
  projectId?: string
  sceneId?: string
  shotId?: string
  /** A preview: the exact text its prompt became (its final reads the same). */
  promptText?: string
  /** A final: the preview it was made from (its library clip and job) and the refine pass's seed. */
  previewItemId?: string
  previewShotId?: string | null
  refineSeed?: number | null
}

/** A scene's final, made from one of its previews. */
export interface FinalRequest {
  previewItemId: string
  scene: SceneRef
  /** The refine pass's seed; left out: the workflow's own. */
  seed?: number
}

/** The project and scene a preview is made for. */
export interface SceneRef {
  projectId: string
  sceneId: string
}

export interface ComfyStatus {
  reachable: boolean
  url: string
  version?: string | null
  device?: string | null
  /** Why ComfyUI can't be reached, ready to show. */
  error: string | null
  workflow: string
  /** What's wrong with the workflow file, if anything. */
  workflowProblem: string | null
  /** Why finals couldn't match their previews with this workflow (null when they can). */
  finalsProblem?: string | null
  /** Set while the language model uses the GPU: new shots wait, and this says why. */
  llmBusy?: string | null
}

/** The language model server (LM Studio, Ollama, …) and what ComfyUI is doing on the shared GPU. */
export interface LlmStatus {
  reachable: boolean
  /** Its OpenAI-compatible address (LLM_URL). */
  url: string
  /** LLM_MODEL, or null when it isn't set. */
  model: string | null
  /** Why it can't be reached, ready to show. */
  error: string | null
  server?: 'lmstudio' | 'ollama' | 'openai'
  serverName?: string
  models?: string[]
  /** Why it can't run (no LLM_MODEL). */
  modelProblem?: string | null
  /** Worth knowing, but it can still try (the server doesn't list LLM_MODEL). */
  modelWarning?: string | null
  /** Whether the server can be asked to unload the model after a run. */
  canUnload?: boolean
  comfy: { reachable: boolean; running: number; pending: number; busy: string | null }
  /** A language model run is waiting or going (from any window). */
  running: boolean
  guide: string
  guideProblem: string | null
}

/** One scene as Write scenes with AI sends it: its time, words (with times), fields and edits. */
export interface WriteScene extends SceneTexts {
  id: string
  start: number
  end: number
  words: { text: string; start: number; end: number }[]
  /** The fields you've edited: the AI's text for them comes back to ask about. */
  edited: SceneTextField[]
}

/** The fields as the AI writes them (its source is AI or stock). */
export type AiTexts = Omit<SceneTexts, 'source'> & { source: 'ai' | 'stock' }

export interface AiSceneResult {
  id: string
  /** Fields to fill in: ones you haven't edited. */
  set: Partial<AiTexts>
  /** The AI's text for fields you've edited (when it differs): asked about, never just used. */
  ask: Partial<AiTexts>
}

/** A merge the AI suggests that keeps the scene 2 to 5 seconds long. */
export interface AiMerge {
  id: string
  next: string
  start: number
  end: number
  why: string
  /** Fields you wrote in the next scene that the merged scene would replace. */
  replacesEdits: SceneTextField[]
}

/** A split the AI suggests, at the start of a word, leaving two scenes of 2 to 5 seconds. */
export interface AiSplit {
  id: string
  at: number
  /** The words the second part begins with. */
  before: string
  second: AiTexts
  why: string
}

export interface WriteResult {
  scenes: AiSceneResult[]
  merges: AiMerge[]
  splits: AiSplit[]
  /** Merges and splits left out, and why (they'd break the 2 to 5 second rule, …). */
  skipped: string[]
  model: string
  /** Answers it took (an invalid one is sent back once). */
  attempts: number
  requests: number
  /** What happened on the GPU: ComfyUI freed, the model unloaded. */
  notes: string[]
}

export interface PromptRequest {
  script: string
  scene: {
    number: number
    start: number
    end: number
    narration: string
    description: string
    prompt: string
    before: string | null
    after: string | null
  }
}

export interface PromptResult {
  prompt: string
  model: string
  attempts: number
  notes: string[]
}

export type ShotStatus = 'queued' | 'running' | 'saving' | 'done' | 'error' | 'cancelled'

/** One variation being made by ComfyUI. */
export interface ShotJob {
  id: string
  batch: string
  variation: number
  variations: number
  prompt: string
  seed: number
  quality: ShotQuality
  megapixels: number
  duration: number
  fps: number
  workflow: string
  basedOn: string | null
  /** 'preview' and 'final' are a scene's (the Scenes tab shows those, not the Shots list). */
  kind?: 'shot' | 'preview' | 'final'
  /** Set for a scene's previews and finals. */
  scene?: SceneRef | null
  /** A final: the preview clip it's made from, and the refine pass's seed. */
  previewItemId?: string
  refineSeed?: number | null
  status: ShotStatus
  /** Jobs ahead of this one in ComfyUI's queue (0 when it's running). */
  queuePosition: number | null
  progress: number
  message: string
  itemId: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface ShotRequest {
  prompt: string
  duration: number
  quality: ShotQuality
  variations: number
  seed?: number
  basedOn?: string
  scene?: SceneRef
}

/** A stock video source that needs an API key in .env. */
export type StockSource = 'pexels' | 'pixabay'
export type Orientation = 'portrait' | 'landscape' | 'any'

/** One search result, the same shape for Pexels and Pixabay. */
export interface StockResult {
  source: StockSource
  id: number
  title: string
  /** The video's page on Pexels or Pixabay. */
  url: string
  duration: number
  width: number
  height: number
  orientation: 'portrait' | 'landscape' | 'square'
  image: string | null
  /** Photographer (Pexels) or uploader (Pixabay). */
  author: string
  authorUrl: string | null
  /** A small file for the hover preview, played straight from the source. */
  previewUrl: string | null
  /** The file that "Add" downloads. */
  file: { width: number; height: number; fps: number | null; quality: string | null }
  /** Set when this video is already in the library. */
  libraryId: string | null
}

export interface StockSearchResult {
  source: StockSource
  page: number
  totalResults: number
  /** False when Pixabay results are still being sorted by orientation (more may match). */
  totalExact?: boolean
  hasMore: boolean
  results: StockResult[]
}

export interface AutofillSentence {
  text: string
  keywords: string[]
  query: string | null
  item: LibraryItem | null
  error: string | null
}

export interface RenderQuality {
  id: 'best' | 'gpu'
  label: string
  description: string
}

/** A timeline clip that uses AI-generated footage. */
export interface AiClip {
  clipId: string
  mediaId: string
  name: string
  source: MediaSource
  start: number
  duration: number
}

export interface RenderWarning {
  kind: 'gaps' | 'past-voiceover' | 'captions-stale' | 'missing-media' | 'low-res' | 'too-long'
  message: string
}

/** What the backend found before a render: the output, the qualities this PC has, and problems. */
export interface RenderCheck {
  duration: number
  frames: number
  fps: { num: number; den: number; label: string }
  width: number
  height: number
  qualities: RenderQuality[]
  warnings: RenderWarning[]
  /** Problems that stop the render (no voiceover, no clips). */
  blockers: string[]
  containsAi: boolean
  aiClips: AiClip[]
}

export interface RenderResult {
  /** Full path of the MP4 on this PC. */
  file: string
  name: string
  folder: string
  size: number
  duration: number
  width: number
  height: number
  fps: string
  quality: string
  containsAi: boolean
  aiClips: AiClip[]
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

export const libraryFileUrl = (itemId: string) => `/api/library/${encodeURIComponent(itemId)}/file`
export const libraryThumbnailUrl = (itemId: string) => `/api/library/${encodeURIComponent(itemId)}/thumbnail`

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
  startCaptions: (projectId: string, body: { file: string; script: string | null }) =>
    request<Job<CaptionResult>>(`${projectPath(projectId)}/captions`, json('POST', body)),
  fonts: () => request<FontInfo[]>('/api/fonts'),
  library: () => request<LibraryItem[]>('/api/library'),
  importClip: (file: File, aiGenerated: boolean) =>
    request<Job<LibraryItem>>('/api/library/import', upload(file, file.name, { aiGenerated: String(aiGenerated) })),
  updateLibraryItem: (itemId: string, changes: { name?: string; aiGenerated?: boolean }) =>
    request<LibraryItem>(`/api/library/${encodeURIComponent(itemId)}`, json('PATCH', changes)),
  deleteLibraryItem: (itemId: string, force = false) =>
    request<{ deleted: string; usedIn: string[] }>(
      `/api/library/${encodeURIComponent(itemId)}${force ? '?force=true' : ''}`,
      { method: 'DELETE' },
    ),
  stockSearch: (source: StockSource, query: string, page: number, orientation: Orientation) =>
    request<StockSearchResult>(`/api/${source}/search?${new URLSearchParams({ query, page: String(page), orientation })}`),
  addFromStock: (source: StockSource, videoId: number) =>
    request<Job<LibraryItem>>(`/api/${source}/${videoId}/add`, json('POST', {})),
  startAutofill: (sentences: string[], source: StockSource | null) =>
    request<Job<{ source: StockSource; sentences: AutofillSentence[] }>>('/api/autofill', json('POST', { sentences, source })),
  comfyStatus: () => request<ComfyStatus>('/api/comfy/status'),
  listShots: () => request<{ jobs: ShotJob[] }>('/api/comfy/shots'),
  generateShots: (shot: ShotRequest) => request<{ jobs: ShotJob[] }>('/api/comfy/shots', json('POST', shot)),
  cancelShot: (jobId: string) => request<ShotJob>(`/api/comfy/shots/${encodeURIComponent(jobId)}/cancel`, json('POST', {})),
  dismissShot: (jobId: string) =>
    request<{ deleted: string }>(`/api/comfy/shots/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
  clearShots: () => request<{ jobs: ShotJob[] }>('/api/comfy/shots/clear', json('POST', {})),
  generateFinal: (final: FinalRequest) => request<{ job: ShotJob }>('/api/comfy/finals', json('POST', final)),
  llmStatus: () => request<LlmStatus>('/api/llm/status'),
  writeScenes: (body: { script: string; scenes: WriteScene[] }) => request<Job<WriteResult>>('/api/llm/scenes', json('POST', body)),
  rewritePrompt: (body: PromptRequest) => request<Job<PromptResult>>('/api/llm/prompt', json('POST', body)),
  renderCheck: (project: Project) => request<RenderCheck>('/api/render/check', json('POST', { project })),
  startRender: (
    body: { project: Project; quality: RenderQuality['id']; fps: { num: number; den: number }; frames: number },
    manifest: { first: number; end: number; size: number }[],
    overlays: Blob,
  ) => {
    const form = new FormData()
    form.append('request', JSON.stringify(body))
    form.append('manifest', JSON.stringify(manifest))
    if (manifest.length) form.append('overlays', overlays, 'overlays.bin')
    return request<Job<RenderResult>>('/api/render', { method: 'POST', body: form })
  },
  cancelRender: (jobId: string) => request<{ cancelled: string }>(`/api/render/${encodeURIComponent(jobId)}/cancel`, json('POST', {})),
  openRender: (file: string, action: 'play' | 'folder') => request<{ opened: string }>('/api/render/open', json('POST', { file, action })),
  getPronunciations: () => request<{ entries: PronunciationEntry[] }>('/api/pronunciations'),
  savePronunciations: (entries: PronunciationEntry[]) =>
    request<{ entries: PronunciationEntry[] }>('/api/pronunciations', json('PUT', { entries })),
  /** Reads a short line with the saved pronunciation list; resolves to WAV audio. */
  say: async (voiceId: string, text: string): Promise<Blob> => {
    let response: Response
    try {
      response = await fetch(`/api/voices/${encodeURIComponent(voiceId)}/say`, json('POST', { text }))
    } catch {
      throw new ApiError('Cannot reach the backend. Is it running?', 0)
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new ApiError(typeof body?.detail === 'string' ? body.detail : `${response.status} ${response.statusText}`, response.status)
    }
    return response.blob()
  },
}

export const fontUrl = (fontId: string) => `/api/fonts/${encodeURIComponent(fontId)}`
