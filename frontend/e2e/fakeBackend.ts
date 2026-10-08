// A stand-in for the FastAPI backend, served through Playwright's request interception.
// AI reads and captions "finish" instantly with plausible results.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page, Route } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const fontFile = readFileSync(path.join(here, '../../backend/app/fonts/files/Montserrat-Black.ttf'))
// 2 s, 180x320: red for the first second, blue for the second. WebM, because Playwright's
// Chromium has no H.264.
const clipFile = readFileSync(path.join(here, 'fixtures/red-then-blue.webm'))
const thumbFile = readFileSync(path.join(here, 'fixtures/thumb.jpg'))
// 2 s, 320x180, all green: a landscape clip for "Fit inside". Use it with wideItem().
const wideFile = readFileSync(path.join(here, 'fixtures/green-wide.webm'))
const wideThumb = readFileSync(path.join(here, 'fixtures/green-wide.jpg'))
const WIDE = 'green-wide.webm'

export const MISSING_KEY = {
  pexels:
    'Stock search needs a free Pexels API key. Get one at https://www.pexels.com/api/, add PEXELS_API_KEY=your-key to the .env file in the app folder, then restart the app.',
  pixabay:
    'Pixabay search needs a free API key. Log in at pixabay.com, copy your key from https://pixabay.com/api/docs/, add PIXABAY_API_KEY=your-key to the .env file in the app folder, then restart the app.',
} as const

type Source = keyof typeof MISSING_KEY

export interface FakeLibraryItem {
  id: string
  kind: 'video' | 'image'
  name: string
  file: string
  thumbnail: string | null
  width: number
  height: number
  duration: number | null
  fps: number | null
  hasAudio: boolean
  size: number
  source: 'pexels' | 'pixabay' | 'upload' | 'ai'
  aiGenerated: boolean
  lowRes: boolean
  originalName: string | null
  addedAt: string
  pexels: { videoId: number; url: string; photographer: string; photographerUrl: string | null } | null
  pixabay: { videoId: number; url: string; uploader: string; uploaderUrl: string | null } | null
  generation: Record<string, unknown> | null
}

export function libraryItem(id: string, overrides: Partial<FakeLibraryItem> = {}): FakeLibraryItem {
  return {
    id,
    kind: 'video',
    name: `Clip ${id}`,
    file: `${id}.webm`,
    thumbnail: `${id}.jpg`,
    width: 180,
    height: 320,
    duration: 2,
    fps: 24,
    hasAudio: false,
    size: clipFile.length,
    source: 'upload',
    aiGenerated: false,
    lowRes: true,
    originalName: `${id}.webm`,
    addedAt: '2026-10-07T00:00:00Z',
    pexels: null,
    pixabay: null,
    generation: null,
    ...overrides,
  }
}

/** A landscape (320x180) green clip. */
export function wideItem(id: string, overrides: Partial<FakeLibraryItem> = {}): FakeLibraryItem {
  return libraryItem(id, { name: `Wide ${id}`, file: WIDE, width: 320, height: 180, originalName: WIDE, ...overrides })
}

export function stockResult(source: Source, id: number, title: string, orientation: 'portrait' | 'landscape' = 'portrait') {
  const [width, height] = orientation === 'portrait' ? [1080, 1920] : [1920, 1080]
  return {
    source,
    id,
    title,
    url: source === 'pexels' ? `https://www.pexels.com/video/${title.toLowerCase().replaceAll(' ', '-')}-${id}/` : `https://pixabay.com/videos/id-${id}/`,
    duration: 12,
    width,
    height,
    orientation,
    image: '/fake-stock/thumb.jpg',
    author: source === 'pexels' ? 'Jane Doe' : 'SeaFilms',
    authorUrl: null,
    previewUrl: '/fake-stock/preview.webm',
    file: { width, height, fps: null, quality: 'hd' },
    libraryId: null as string | null,
  }
}

export const pexelsResult = (id: number, title: string) => stockResult('pexels', id, title)

type Result = ReturnType<typeof stockResult>

export interface FakeShot {
  id: string
  batch: string
  variation: number
  variations: number
  prompt: string
  seed: number
  quality: 'draft' | 'final'
  megapixels: number
  duration: number
  fps: number
  workflow: string
  basedOn: string | null
  scene: { projectId: string; sceneId: string } | null
  status: 'queued' | 'running' | 'saving' | 'done' | 'error' | 'cancelled'
  queuePosition: number | null
  progress: number
  message: string
  itemId: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

/** An AI shot in the library, as Generate shot saves it. */
export function aiShotItem(id: string, prompt: string, quality: 'draft' | 'final' = 'draft', seed = 1234) {
  return libraryItem(id, {
    name: prompt.slice(0, 40),
    source: 'ai',
    aiGenerated: true,
    width: 480,
    height: 864,
    hasAudio: true,
    generation: {
      prompt,
      seed,
      quality,
      megapixels: quality === 'draft' ? 0.4 : 0.8,
      resolution: quality === 'draft' ? '480x864' : '672x1200',
      duration: 3,
      fps: 24,
      workflow: 'ltx_t2v_api.json',
      basedOn: null,
      generatedAt: '2026-10-07T00:00:00Z',
    },
  })
}

interface FakeOptions {
  library?: FakeLibraryItem[]
  /** For each source, null (or left out): no API key; otherwise the videos searches find. */
  pexels?: Result[] | null
  pixabay?: Result[] | null
  /** Whether the fake ComfyUI answers (default: yes). */
  comfy?: boolean
}

/** One second of silent 16-bit mono WAV, enough for the waveform to decode. */
function silentWav(seconds = 1, rate = 8000): Buffer {
  const samples = seconds * rate
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  return buffer
}

/** Serves a file the way the real backend does, honouring Range so video can seek. */
function serveFile(route: Route, body: Buffer, contentType: string) {
  const range = /bytes=(\d*)-(\d*)/.exec(route.request().headers()['range'] ?? '')
  if (!range) return route.fulfill({ status: 200, contentType, body, headers: { 'Accept-Ranges': 'bytes' } })
  const start = range[1] ? Number(range[1]) : body.length - Number(range[2])
  const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
  return route.fulfill({
    status: 206,
    contentType,
    body: body.subarray(start, end + 1),
    headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` },
  })
}

interface Job {
  id: string
  kind: string
  status: 'done'
  progress: number
  message: string
  result: unknown
  error: null
}

export async function fakeBackend(page: Page, options: FakeOptions = {}) {
  const projects = new Map<string, Record<string, unknown>>()
  const jobs = new Map<string, Job>()
  const library: FakeLibraryItem[] = [...(options.library ?? [])]
  const stock: Record<Source, Result[] | null> = { pexels: options.pexels ?? null, pixabay: options.pixabay ?? null }
  /** Searches allowed before the fake Pixabay says the rate limit is used up (null: no limit). */
  const limits: Record<Source, number | null> = { pexels: null, pixabay: null }
  const searched: { source: Source; query: string; orientation: string }[] = []
  const comfy = { reachable: options.comfy ?? true }
  const shots: FakeShot[] = []
  const shotRequests: Record<string, unknown>[] = []
  let seedCounter = 1000
  let pronunciations: unknown[] = []
  let counter = 0

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const finished = (kind: string, result: unknown) => {
    const job: Job = { id: `job-${++counter}`, kind, status: 'done', progress: 1, message: 'Done', result, error: null }
    jobs.set(job.id, job)
    return job
  }

  await page.route('**/fake-stock/**', (route) =>
    route.request().url().endsWith('.jpg')
      ? route.fulfill({ status: 200, contentType: 'image/jpeg', body: thumbFile })
      : serveFile(route, clipFile, 'video/webm'),
  )

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const parts = url.pathname.split('/').filter(Boolean).slice(1) // drop "api"
    const method = request.method()

    if (parts[0] === 'health') {
      return json(route, {
        status: 'ok',
        app: 'Shorts Creator',
        version: 'test',
        python: '3.14',
        ffmpeg: true,
        pexels: stock.pexels !== null,
        pixabay: stock.pixabay !== null,
        canvas: { width: 1080, height: 1920, fps: 30 },
        tts: { device: 'cpu', directmlAvailable: false, modelReady: true, provider: 'CPU' },
        captions: { model: 'small.en', modelReady: true },
      })
    }
    if (parts[0] === 'voices') {
      return json(route, [{ id: 'af_heart', name: 'Heart', accent: 'US', gender: 'F', description: 'Warm storyteller' }])
    }
    if (parts[0] === 'fonts') {
      if (parts.length === 1) return json(route, [{ id: 'montserrat', name: 'Montserrat Black' }])
      return route.fulfill({ status: 200, contentType: 'font/ttf', body: fontFile })
    }
    if (parts[0] === 'pronunciations') {
      if (method === 'PUT') pronunciations = (request.postDataJSON() as { entries: unknown[] }).entries
      return json(route, { entries: pronunciations })
    }
    if (parts[0] === 'jobs') return json(route, jobs.get(parts[1]))
    if (parts[0] === 'comfy') {
      if (parts[1] === 'status') {
        return json(route, {
          reachable: comfy.reachable,
          url: 'http://127.0.0.1:8188',
          version: comfy.reachable ? '0.9.0' : null,
          device: comfy.reachable ? 'AMD Radeon RX 9060 XT' : null,
          error: comfy.reachable ? null : "ComfyUI isn't answering at http://127.0.0.1:8188. Open ComfyUI Desktop and wait until it has finished starting, then try again.",
          workflow: 'ltx_t2v_api.json',
          workflowProblem: null,
        })
      }
      if (parts[1] === 'shots' && parts.length === 2 && method === 'GET') return json(route, { jobs: [...shots].reverse() })
      if (parts[1] === 'shots' && parts.length === 2 && method === 'POST') {
        const body = request.postDataJSON() as {
          prompt: string
          duration: number
          quality: 'draft' | 'final'
          variations: number
          seed?: number
          basedOn?: string
          scene?: { projectId: string; sceneId: string }
        }
        shotRequests.push(body)
        const batch = `b-${++counter}`
        const made: FakeShot[] = []
        for (let variation = 1; variation <= body.variations; variation++) {
          const shot: FakeShot = {
            id: `g-${++counter}`,
            batch,
            variation,
            variations: body.variations,
            prompt: body.prompt,
            seed: body.seed ?? ++seedCounter,
            quality: body.quality,
            megapixels: body.quality === 'draft' ? 0.4 : 0.8,
            duration: body.duration,
            fps: 24,
            workflow: 'ltx_t2v_api.json',
            basedOn: body.basedOn ?? null,
            scene: body.scene ?? null,
            status: 'queued',
            queuePosition: shots.filter((s) => s.status === 'queued' || s.status === 'running').length,
            progress: 0,
            message: "Waiting in ComfyUI's queue…",
            itemId: null,
            error: null,
            createdAt: new Date(Date.now() + counter).toISOString(),
            startedAt: null,
            finishedAt: null,
          }
          shots.push(shot)
          made.push(shot)
        }
        return json(route, { jobs: made })
      }
      if (parts[1] === 'shots' && parts[2] === 'clear') {
        // Scene previews aren't in the Shots list, so clearing it leaves them.
        for (let i = shots.length - 1; i >= 0; i--) if (['done', 'error', 'cancelled'].includes(shots[i].status) && !shots[i].scene) shots.splice(i, 1)
        return json(route, { jobs: [...shots].reverse() })
      }
      const shot = shots.find((s) => s.id === parts[2])
      if (shot && parts[3] === 'cancel') {
        Object.assign(shot, { status: 'cancelled', message: '', queuePosition: null })
        return json(route, shot)
      }
      if (shot && method === 'DELETE') {
        shots.splice(shots.indexOf(shot), 1)
        return json(route, { deleted: shot.id })
      }
    }
    if (parts[0] === 'library') {
      if (parts.length === 1) return json(route, library)
      if (parts[1] === 'import') {
        // Multipart body: pick out the file name and the AI-generated field.
        const body = request.postDataBuffer()?.toString('latin1') ?? ''
        const fileName = /filename="([^"]+)"/.exec(body)?.[1] ?? 'clip.webm'
        const ai = /name="aiGenerated"\r\n\r\n(true|false)/.exec(body)?.[1] === 'true'
        const item = libraryItem(`m-import${++counter}`, { name: fileName.replace(/\.[^.]+$/, ''), originalName: fileName, aiGenerated: ai })
        library.unshift(item)
        return json(route, finished('import', item))
      }
      const item = library.find((i) => i.id === parts[1])
      if (!item) return json(route, { detail: 'Library item was not found. Was it deleted?' }, 404)
      const wide = item.file === WIDE
      if (parts[2] === 'file') return serveFile(route, wide ? wideFile : clipFile, 'video/webm')
      if (parts[2] === 'thumbnail') return route.fulfill({ status: 200, contentType: 'image/jpeg', body: wide ? wideThumb : thumbFile })
      if (method === 'PATCH') {
        Object.assign(item, request.postDataJSON())
        return json(route, item)
      }
      if (method === 'DELETE') {
        library.splice(library.indexOf(item), 1)
        return json(route, { deleted: item.id, usedIn: [] })
      }
    }
    if (parts[0] === 'pexels' || parts[0] === 'pixabay') {
      const source = parts[0]
      const videos = stock[source]
      if (videos === null) return json(route, { detail: MISSING_KEY[source] }, 400)
      if (parts[1] === 'search') {
        const orientation = url.searchParams.get('orientation') ?? 'portrait'
        searched.push({ source, query: url.searchParams.get('query') ?? '', orientation })
        const limit = limits[source]
        if (limit !== null) {
          if (limit <= 0) {
            return json(route, { detail: "Pixabay's rate limit is used up (100 requests a minute). You can search Pixabay again in 3 seconds, at 12:00:03.", retryAfter: 3 }, 429)
          }
          limits[source] = limit - 1
        }
        const results = videos.filter((r) => orientation === 'any' || r.orientation === orientation)
        return json(route, { source, page: 1, totalResults: results.length, totalExact: true, hasMore: false, results })
      }
      const result = videos.find((r) => r.id === Number(parts[1]))
      if (parts[2] === 'add' && result) {
        const credit = { videoId: result.id, url: result.url }
        const item = libraryItem(`m-${source}${result.id}`, {
          name: result.title,
          source,
          width: result.file.width,
          height: result.file.height,
          lowRes: false,
          pexels: source === 'pexels' ? { ...credit, photographer: result.author, photographerUrl: null } : null,
          pixabay: source === 'pixabay' ? { ...credit, uploader: result.author, uploaderUrl: null } : null,
        })
        library.unshift(item)
        result.libraryId = item.id
        return json(route, finished(source, item))
      }
    }
    if (parts[0] === 'projects') {
      if (parts.length === 1) {
        const ai = new Set(library.filter((i) => i.aiGenerated).map((i) => i.id))
        return json(
          route,
          [...projects.values()].map((p) => ({
            id: p.id,
            name: p.name,
            createdAt: null,
            updatedAt: null,
            aiClips: ((p.clips as { mediaId: string }[]) ?? []).filter((c) => ai.has(c.mediaId)).length,
          })),
        )
      }
      const id = parts[1]
      if (parts.length === 2 && method === 'PUT') {
        const project = request.postDataJSON() as Record<string, unknown>
        projects.set(id, project)
        return json(route, { id, name: project.name, createdAt: null, updatedAt: null })
      }
      if (parts.length === 2) return projects.has(id) ? json(route, projects.get(id)) : json(route, { detail: 'not found' }, 404)
      if (parts[2] === 'media') return route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() })
      if (parts[2] === 'voiceover' && parts[3] === 'ai') {
        const body = request.postDataJSON() as { text: string; voiceId: string; speed: number }
        const file = `voiceover-test-${++counter}.wav`
        return json(route, finished('voiceover', { source: 'ai', file, duration: 8, voiceId: body.voiceId, speed: body.speed, script: body.text }))
      }
      if (parts[2] === 'captions') {
        const body = request.postDataJSON() as { file: string; script: string }
        const words = body.script.split(/\s+/).filter(Boolean).map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.28 }))
        return json(route, finished('captions', { words, source: 'script', matched: 1, model: 'small.en', voiceoverFile: body.file }))
      }
    }
    return json(route, { detail: `fake backend: no route for ${method} ${url.pathname}` }, 404)
  })

  /** Moves a shot along, as the real backend would while ComfyUI works on it. */
  const runShot = (index: number, change: 'running' | 'done' | 'error', progress = 0.4) => {
    const shot = shots[index]
    if (change === 'running') {
      Object.assign(shot, { status: 'running', queuePosition: 0, progress, message: 'Generating, pass 1 of 2 (step 5 of 8)…', startedAt: new Date().toISOString() })
    } else if (change === 'error') {
      Object.assign(shot, { status: 'error', error: 'ComfyUI failed in SamplerCustomAdvanced (405:344): CUDA out of memory', message: '', queuePosition: null })
    } else {
      const item = aiShotItem(`m-${shot.id}`, shot.prompt, shot.quality, shot.seed)
      // A scene preview is saved with its project and scene, as the real backend does.
      if (shot.scene) item.generation = { ...item.generation, type: 'preview', ...shot.scene, shotId: shot.id }
      library.unshift(item)
      Object.assign(shot, { status: 'done', progress: 1, itemId: item.id, message: '', queuePosition: null })
    }
    let ahead = 0
    for (const other of shots) {
      if (other.status === 'queued') other.queuePosition = ahead + (shots.some((s) => s.status === 'running') ? 1 : 0)
      if (other.status === 'queued') ahead++
    }
  }

  return { library, projects, searched, limits, comfy, shots, shotRequests, runShot }
}
