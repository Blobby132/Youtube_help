// A stand-in for the FastAPI backend, served through Playwright's request interception.
// AI reads and captions "finish" instantly with plausible results.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page, Route } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const fontFile = readFileSync(path.join(here, '../../backend/app/fonts/files/Montserrat-Black.ttf'))

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

interface Job {
  id: string
  kind: string
  status: 'done'
  progress: number
  message: string
  result: unknown
  error: null
}

export async function fakeBackend(page: Page) {
  const projects = new Map<string, Record<string, unknown>>()
  const jobs = new Map<string, Job>()
  let pronunciations: unknown[] = []
  let counter = 0

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const finished = (kind: string, result: unknown) => {
    const job: Job = { id: `job-${++counter}`, kind, status: 'done', progress: 1, message: 'Done', result, error: null }
    jobs.set(job.id, job)
    return job
  }

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
        pexels: false,
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
    if (parts[0] === 'projects') {
      if (parts.length === 1) {
        return json(route, [...projects.values()].map((p) => ({ id: p.id, name: p.name, createdAt: null, updatedAt: null })))
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
}
