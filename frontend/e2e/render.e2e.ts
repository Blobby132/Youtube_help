// The render dialog against the faked backend: the checks, the quality choice, progress with
// cancel, and the finished screen. (e2e-render/render.e2e.ts renders for real with FFmpeg.)
import { expect, test, type Page, type Route } from '@playwright/test'
import { fakeBackend, wideItem } from './fakeBackend'

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const QUALITIES = {
  best: { id: 'best', label: 'Best quality', description: 'libx264 at CRF 18 on the CPU: the sharpest result, slower to make.' },
  gpu: { id: 'gpu', label: 'Fast (GPU)', description: "AMD's hardware encoder: much faster, slightly larger files for the same quality." },
}

function check(gpu: boolean, warnings: { kind: string; message: string }[]) {
  return {
    duration: 8,
    frames: 240,
    fps: { num: 30, den: 1, label: '30' },
    width: 1080,
    height: 1920,
    qualities: gpu ? [QUALITIES.best, QUALITIES.gpu] : [QUALITIES.best],
    warnings,
    blockers: [],
    containsAi: false,
    aiClips: [],
  }
}

async function projectWithClip(page: Page) {
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await page.getByRole('textbox', { name: 'Script' }).fill('Every airplane window has a tiny hole in it.')
  await page.getByRole('button', { name: 'Generate AI read' }).click()
  await expect(page.getByText('AI read · Heart')).toBeVisible()
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByRole('button', { name: 'Add “Wide field” to the timeline' }).click()
}

test('warnings before rendering, then progress, elapsed time and cancel', async ({ page }) => {
  await fakeBackend(page, { library: [wideItem('m-wide', { name: 'Wide field' })] })
  const cancelled: string[] = []
  const warnings = [
    { kind: 'gaps', message: 'A gap in the timeline will render black: 0:02.00–0:08.00.' },
    { kind: 'low-res', message: 'Low-resolution clips will be scaled up and may look soft: “Wide field” (320×180, scaled up 3.4×).' },
  ]
  await page.route('**/api/render/**', (route) => {
    const url = route.request().url()
    if (url.endsWith('/check')) return json(route, check(false, warnings))
    if (url.endsWith('/job-render/cancel')) {
      cancelled.push('job-render')
      return json(route, { cancelled: 'job-render' })
    }
    return json(route, { detail: 'unexpected' }, 404)
  })
  await page.route('**/api/render', (route) =>
    json(route, { id: 'job-render', kind: 'render', status: 'running', progress: 0, message: 'Rendering…', result: null, error: null }),
  )
  await page.route('**/api/jobs/job-render', (route) =>
    json(route, { id: 'job-render', kind: 'render', status: 'running', progress: 0.4, message: 'Rendering…', result: null, error: null }),
  )
  await projectWithClip(page)

  await page.getByRole('button', { name: 'Render', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Render video' })
  await expect(dialog.getByText('0:08 · 1080×1920 · 30 fps')).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(2)
  await expect(dialog).toContainText('will render black: 0:02.00–0:08.00')
  await expect(dialog).toContainText('scaled up 3.4×')
  // No AMD encoder on this PC: only Best quality, no choice to make.
  await expect(dialog.getByRole('radio', { name: 'Fast (GPU)' })).toHaveCount(0)
  await expect(dialog).toContainText('Best quality')

  await dialog.getByRole('button', { name: 'Render anyway' }).click()
  const rendering = page.getByRole('dialog', { name: 'Rendering' })
  await expect(rendering.getByRole('progressbar', { name: 'Render progress' })).toHaveAttribute('aria-valuenow', '43')
  await expect(rendering.getByLabel('Elapsed time')).toHaveText(/^0:0\d$/)
  // The top bar shows the progress too, and the dialog can be closed while it renders.
  await rendering.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('button', { name: 'Rendering 43%' })).toBeVisible()
  await page.getByRole('button', { name: 'Rendering 43%' }).click()

  await rendering.getByRole('button', { name: 'Cancel render' }).click()
  await expect(page.getByRole('dialog', { name: 'Render video' })).toContainText('Render cancelled. The partial file was deleted.')
  expect(cancelled).toEqual(['job-render'])
  await expect(page.getByRole('button', { name: 'Render', exact: true })).toBeVisible()
})

test('Fast (GPU) when the PC has it; the finished video with play, open folder and the AI reminder', async ({ page }) => {
  await fakeBackend(page, { library: [wideItem('m-wide', { name: 'Wide field', aiGenerated: true })] })
  const requests: Record<string, unknown>[] = []
  const opened: unknown[] = []
  await page.route('**/api/render/**', (route) => {
    const url = route.request().url()
    if (url.endsWith('/check')) return json(route, check(true, []))
    if (url.endsWith('/open')) {
      opened.push(route.request().postDataJSON())
      return json(route, { opened: 'x' })
    }
    return json(route, { detail: 'unexpected' }, 404)
  })
  await page.route('**/api/render', (route) => {
    const body = route.request().postDataBuffer()?.toString('utf8') ?? ''
    requests.push(JSON.parse(/name="request"\r\n\r\n(.*)\r\n/.exec(body)![1]))
    return json(route, { id: 'job-done', kind: 'render', status: 'queued', progress: 0, message: '', result: null, error: null })
  })
  const result = {
    file: 'C:\\Shorts\\exports\\Untitled short\\Untitled short.mp4',
    name: 'Untitled short.mp4',
    folder: 'C:\\Shorts\\exports\\Untitled short',
    size: 3_456_789,
    duration: 8,
    width: 1080,
    height: 1920,
    fps: '30',
    quality: 'Fast (GPU)',
    containsAi: true,
    aiClips: [{ clipId: 'c', mediaId: 'm-wide', name: 'Wide field', source: 'ai', start: 0, duration: 2 }],
  }
  await page.route('**/api/jobs/job-done', (route) =>
    json(route, { id: 'job-done', kind: 'render', status: 'done', progress: 1, message: 'Done', result, error: null }),
  )
  await projectWithClip(page)

  await page.getByRole('button', { name: 'Render', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Render video' })
  await expect(dialog.getByText('No problems found.')).toBeVisible()
  await dialog.getByRole('radio', { name: 'Fast (GPU)' }).click()
  await expect(dialog).toContainText("AMD's hardware encoder")
  await dialog.getByRole('button', { name: 'Render', exact: true }).click()

  const done = page.getByRole('dialog', { name: 'Video ready' })
  await expect(done).toContainText('Untitled short.mp4')
  await expect(done).toContainText('C:\\Shorts\\exports\\Untitled short')
  await expect(done).toContainText('3.3 MB')
  await expect(done).toContainText('mark it as containing altered or synthetic content')
  expect(requests[0]).toMatchObject({ quality: 'gpu', fps: { num: 30, den: 1 }, frames: 240 })
  expect((requests[0].project as { id: string }).id).toMatch(/^p/)

  await done.getByRole('button', { name: 'Play' }).click()
  await done.getByRole('button', { name: 'Open folder' }).click()
  await expect.poll(() => opened).toEqual([
    { file: result.file, action: 'play' },
    { file: result.file, action: 'folder' },
  ])
})
