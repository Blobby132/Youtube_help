// Renders a short project with the real backend and FFmpeg, then checks the MP4 against the
// preview: frames at chosen times must match the preview canvas, with the rank number and the
// caption where the layout puts them.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { layoutRank, RANK_LABEL_SCALE, rankTop, TITLE_BAR_PADDING, TITLE_TOP } from '../src/features/canvas/overlayLayout'
import { CAPTION_CENTER, LINE_HEIGHT } from '../src/features/preview/captionLayout'

const W = 1080
const H = 1920
const PROJECT_ID = 'p-render-e2e'
const RANK_COLOR = [0xff, 0xd6, 0x0a] as const // #ffd60a
const RANK_SIZE = 200
const TITLE_SIZE = 72
const CAPTION_SIZE = 90
// The title is one line in its bar. Under it the rank number, centred on `numberY`, then the
// label (layoutRank).
const TITLE_BOTTOM = TITLE_TOP + TITLE_SIZE * LINE_HEIGHT + 2 * TITLE_SIZE * TITLE_BAR_PADDING
const RANK = layoutRank({ words: ['x'], widths: [10], spaceWidth: 5 }, { fontId: 'anton', size: RANK_SIZE, numberColor: '', labelColor: '' }, rankTop(TITLE_BOTTOM), W)
const LABEL_TOP = RANK.label[0].y - (Math.round(RANK_SIZE * RANK_LABEL_SCALE) * LINE_HEIGHT) / 2
// Lines of the caption at each moment: "BLUE IS CALM" fits one line, "GREEN GROWS EVERYWHERE" wraps.
const CAPTION_LINES = [1, 1, 2]
const HIGHLIGHT = [0x00, 0xe5, 0xff] as const // #00e5ff

const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

/** An RGB picture, 3 bytes per pixel. */
type Picture = Buffer

function decode(file: string, seconds?: number): Picture {
  const seek = seconds === undefined ? [] : ['-ss', seconds.toFixed(3)]
  return execFileSync('ffmpeg', ['-v', 'error', ...seek, '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: W * H * 4,
  })
}

/** Bounding box of the pixels close to `color`. */
function boxOf(picture: Picture, color: readonly number[], tolerance = 40) {
  let left = W
  let top = H
  let right = -1
  let bottom = -1
  let count = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      if (
        Math.abs(picture[i] - color[0]) < tolerance &&
        Math.abs(picture[i + 1] - color[1]) < tolerance &&
        Math.abs(picture[i + 2] - color[2]) < tolerance
      ) {
        count++
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
  }
  return { count, left, top, right, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2 }
}

/** Mean difference per channel, and the share of pixels that differ a lot. */
function difference(a: Picture, b: Picture) {
  let sum = 0
  let far = 0
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    sum += d / 3
    if (d > 180) far++
  }
  return { mean: sum / (a.length / 3), far: far / (a.length / 3) }
}

async function waitForJob(request: APIRequestContext, job: { id: string; status: string }) {
  for (let i = 0; i < 300 && (job.status === 'queued' || job.status === 'running'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    job = await (await request.get(`/api/jobs/${job.id}`)).json()
  }
  expect(job.status).toBe('done')
  return (job as unknown as { result: Record<string, unknown> }).result
}

async function importClip(request: APIRequestContext, file: string, aiGenerated: boolean) {
  const response = await request.post('/api/library/import', {
    multipart: {
      file: { name: file.split('/').pop()!, mimeType: 'video/webm', buffer: readFileSync(file) },
      aiGenerated: String(aiGenerated),
    },
  })
  expect(response.ok()).toBe(true)
  return waitForJob(request, await response.json()) as Promise<{ id: string }>
}

/** The preview canvas at `seconds`, once its clip frame and fonts are drawn. */
async function previewAt(page: Page, seconds: number, file: string): Promise<Picture> {
  await page.getByRole('slider', { name: 'Seek', exact: true }).fill(String(seconds))
  const canvas = page.getByTestId('preview-canvas')
  let previous = ''
  // Wait until two captures a moment apart are identical (the video frame has been decoded
  // and every font has loaded).
  await expect
    .poll(
      async () => {
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(150)
        const url = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png'))
        const same = url === previous
        previous = url
        return same
      },
      { timeout: 20_000 },
    )
    .toBe(true)
  writeFileSync(file, Buffer.from(previous.split(',')[1], 'base64'))
  return decode(file)
}

test('the rendered MP4 matches the preview', async ({ page, request }, testInfo) => {
  // Clips: 24 fps blue (portrait, full HD) and 25 fps green (landscape, full HD). WebM, which Playwright's
  // Chromium plays in the preview.
  const blue = testInfo.outputPath('blue.webm')
  const green = testInfo.outputPath('green.webm')
  const voice = testInfo.outputPath('voice.wav')
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x2040c0:s=1080x1920:r=24:d=3', '-c:v', 'libvpx', '-b:v', '1M', blue)
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x20a040:s=1920x1080:r=25:d=3', '-c:v', 'libvpx', '-b:v', '1M', green)
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000', '-ac', '1', voice)

  const blueItem = await importClip(request, blue, false)
  const greenItem = await importClip(request, green, true)
  const voiceResponse = await request.post(`/api/projects/${PROJECT_ID}/voiceover/upload`, {
    multipart: { file: { name: 'voice.wav', mimeType: 'audio/wav', buffer: readFileSync(voice) }, source: 'upload' },
  })
  expect(voiceResponse.ok()).toBe(true)
  const voiceover = await voiceResponse.json()

  const word = (id: string, text: string, start: number, end: number) => ({ id, text, start, end })
  const clip = (id: string, mediaId: string, start: number, fit: 'fill' | 'inside') => ({
    id, mediaId, start, duration: 2, inPoint: 0, speed: 1, cropX: 0.5, cropY: 0.5, fit, keepAudio: false, volume: 0.5,
  })
  const project = {
    id: PROJECT_ID,
    name: 'Render check',
    version: 2,
    script: 'Blue is calm. Green grows everywhere.',
    voiceover,
    clips: [clip('c1', blueItem.id, 0, 'fill'), clip('c2', greenItem.id, 2, 'inside')],
    captions: {
      enabled: true,
      voiceoverFile: voiceover.file,
      source: 'script',
      words: [
        word('w1', 'Blue', 0.2, 0.6),
        word('w2', 'is', 0.6, 0.9),
        word('w3', 'calm.', 0.9, 1.7),
        word('w4', 'Green', 2.1, 2.6),
        word('w5', 'grows', 2.6, 3.0),
        word('w6', 'everywhere.', 3.0, 3.8),
      ],
      style: {
        fontId: 'montserrat', fontSize: CAPTION_SIZE, color: '#ffffff', highlightColor: '#00e5ff', outlineColor: '#000000',
        outlineWidth: 8, shadow: true, uppercase: true, position: 'bottom', wordsPerCaption: 3,
      },
    },
    canvas: {
      background: { mode: 'color', color: '#202020', blur: 40 },
      title: {
        enabled: true, text: 'Two colours, ranked', fontId: 'anton', fontSize: TITLE_SIZE, color: '#ffffff', bar: true,
        barColor: '#000000', timing: 'full', seconds: 3,
      },
    },
    ranking: {
      enabled: true,
      direction: 'down',
      entries: [
        { id: 'r1', label: 'Calm blue', time: { start: 0, end: 2 } },
        { id: 'r2', label: 'Growing green', time: { start: 2, end: 4 } },
      ],
      style: { fontId: 'anton', size: RANK_SIZE, numberColor: '#ffd60a', labelColor: '#ffffff' },
    },
  }
  expect((await request.put(`/api/projects/${PROJECT_ID}`, { data: project })).ok()).toBe(true)

  await page.addInitScript((id) => localStorage.setItem('shorts-creator.lastProjectId', id), PROJECT_ID)
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Render', exact: true })).toBeEnabled()

  // Moments to compare: #2 with "BLUE" highlighted, #2 with "CALM", #1 over the Fit inside clip.
  const moments = [0.4, 1.2, 2.8]
  const previews = []
  for (const [i, seconds] of moments.entries()) previews.push(await previewAt(page, seconds, testInfo.outputPath(`preview-${i}.png`)))

  // Render: the checks find nothing to warn about, then the finished screen.
  await page.getByRole('button', { name: 'Render', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('No problems found.')).toBeVisible()
  await expect(dialog.getByText('0:04 · 1080×1920 · 30 fps')).toBeVisible()
  await dialog.getByRole('button', { name: 'Render', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: 'Video ready' })).toBeVisible({ timeout: 150_000 })
  await expect(dialog).toContainText('Render check.mp4')
  await expect(dialog).toContainText('mark it as containing altered or synthetic content')
  const folder = (await dialog.getByTestId('render-folder').textContent())!
  const output = `${folder}/Render check.mp4`

  // The file: 1080x1920 H.264 at 30 fps (24 and 25 fps clips), AAC 48 kHz, 4 s.
  const info = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]).toString(),
  )
  const video = info.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
  const audio = info.streams.find((s: { codec_type: string }) => s.codec_type === 'audio')
  expect([video.codec_name, video.width, video.height, video.pix_fmt, video.r_frame_rate]).toEqual(['h264', W, H, 'yuv420p', '30/1'])
  expect([audio.codec_name, audio.sample_rate]).toEqual(['aac', '48000'])
  expect(Math.abs(Number(info.format.duration) - 4)).toBeLessThan(0.05)

  for (const [i, seconds] of moments.entries()) {
    const preview = previews[i]
    const rendered = decode(output, seconds + 0.001)
    writeFileSync(testInfo.outputPath(`render-${i}.rgb`), rendered)

    // The whole frame matches the preview.
    const diff = difference(preview, rendered)
    expect(diff.mean, `mean difference at ${seconds} s`).toBeLessThan(3.5)
    expect(diff.far, `share of very different pixels at ${seconds} s`).toBeLessThan(0.0005)

    // The rank number: centred, between the title bar and its label, on the line the layout
    // gives it (the glyphs' own middle sits a little above the em box's middle in Anton).
    const rankPreview = boxOf(preview, RANK_COLOR)
    const rankRender = boxOf(rendered, RANK_COLOR)
    expect(rankRender.count).toBeGreaterThan(2000)
    expect(Math.abs(rankRender.cx - W / 2)).toBeLessThan(12)
    expect(Math.abs(rankRender.cy - RANK.numberY)).toBeLessThan(40)
    expect(rankRender.top).toBeGreaterThan(TITLE_BOTTOM)
    expect(rankRender.bottom).toBeLessThan(LABEL_TOP)
    for (const key of ['left', 'top', 'right', 'bottom'] as const) {
      expect(Math.abs(rankRender[key] - rankPreview[key]), `rank number ${key} at ${seconds} s`).toBeLessThanOrEqual(3)
    }

    // The highlighted caption word: inside the caption block centred at 72% of the height
    // (captionLayout.ts, position "bottom"), and in the same place as in the preview.
    const wordPreview = boxOf(preview, HIGHLIGHT)
    const wordRender = boxOf(rendered, HIGHLIGHT)
    const lines = CAPTION_LINES[i]
    const block = { top: H * CAPTION_CENTER.bottom - (lines * CAPTION_SIZE * LINE_HEIGHT) / 2, bottom: H * CAPTION_CENTER.bottom + (lines * CAPTION_SIZE * LINE_HEIGHT) / 2 }
    expect(wordRender.count).toBeGreaterThan(1000)
    expect(wordRender.top).toBeGreaterThanOrEqual(block.top)
    expect(wordRender.bottom).toBeLessThanOrEqual(block.bottom)
    for (const key of ['left', 'top', 'right', 'bottom'] as const) {
      expect(Math.abs(wordRender[key] - wordPreview[key]), `caption word ${key} at ${seconds} s`).toBeLessThanOrEqual(3)
    }
  }
})
