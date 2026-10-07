import { expect, test } from '@playwright/test'
import { aiShotItem, fakeBackend } from './fakeBackend'

const PROMPT = 'A red fox trots through deep snow at dusk, slow tracking shot'

test('Generate shot explains that ComfyUI Desktop needs to be open', async ({ page }) => {
  const backend = await fakeBackend(page, { comfy: false })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Media' }).click()
  await expect(page.getByTestId('comfy-status')).toContainText("ComfyUI isn't running")
  const button = page.getByRole('button', { name: 'Generate shot' })
  await expect(button).toBeDisabled()
  await expect(page.getByText('Open ComfyUI Desktop first: Generate shot uses it to make the clips.')).toBeVisible()

  // Once ComfyUI is open, a re-check enables the button.
  backend.comfy.reachable = true
  await page.getByRole('button', { name: 'Check ComfyUI again' }).click()
  await expect(page.getByTestId('comfy-status')).toContainText('ComfyUI connected · AMD Radeon RX 9060 XT')
  await expect(button).toBeEnabled()
})

test('generate variations, follow them across a reload, cancel one', async ({ page }) => {
  const backend = await fakeBackend(page)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByRole('button', { name: 'Generate shot' }).click()

  const dialog = page.getByRole('dialog', { name: 'Generate shot' })
  await dialog.getByLabel('Prompt').fill(PROMPT)
  await dialog.getByRole('radio', { name: '4 s' }).click()
  await dialog.getByRole('radio', { name: 'Final' }).click()
  await dialog.getByRole('radiogroup', { name: 'Variations' }).getByRole('radio', { name: '2', exact: true }).click()
  await expect(dialog).toContainText('Final: 0.8 megapixels')
  await dialog.getByRole('button', { name: 'Generate 2 variations' }).click()
  await expect(dialog).toBeHidden()
  expect(backend.shotRequests).toEqual([{ prompt: PROMPT, duration: 4, quality: 'final', variations: 2 }])

  const jobs = page.getByTestId('shot-job')
  await expect(jobs).toHaveCount(2)
  await expect(jobs.filter({ hasText: 'Variation 1 of 2 · Final · 4 s' })).toContainText("Waiting in ComfyUI's queue")

  // The jobs live in the backend: a reload shows them again, and they keep moving.
  await page.reload()
  await page.getByRole('tab', { name: 'Media' }).click()
  await expect(jobs).toHaveCount(2)
  backend.runShot(0, 'running')
  const first = jobs.filter({ hasText: 'Variation 1 of 2' })
  await expect(first).toContainText('Generating, pass 1 of 2 (step 5 of 8)…')
  await expect(first.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')

  // Cancel the waiting one.
  const second = jobs.filter({ hasText: 'Variation 2 of 2' })
  await second.getByRole('button', { name: 'Cancel' }).click()
  await expect(second).toContainText('Cancelled')

  // The first finishes: it's in the library (not on the timeline), with its prompt.
  backend.runShot(0, 'done')
  await expect(first).toContainText('Added to the library')
  const card = page.getByTestId('library-item').filter({ hasText: PROMPT.slice(0, 20) })
  await expect(card.getByTestId('ai-shot')).toContainText(PROMPT)
  await expect(card).toContainText('480×864 · 2.0 s · AI shot')
  await expect(page.getByTestId('timeline-clip')).toHaveCount(0)

  await page.getByRole('button', { name: 'Clear finished' }).click()
  await expect(jobs).toHaveCount(0)
})

test('an AI clip card copies its prompt and makes more like it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const backend = await fakeBackend(page, { library: [aiShotItem('m-draft', PROMPT, 'draft', 4242)] })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Media' }).click()
  const card = page.getByTestId('ai-shot')
  await expect(card).toContainText('Draft · 480×864 · seed 4242')
  await expect(card).toContainText("the result won't match this draft exactly")

  await card.getByRole('button', { name: 'Copy prompt' }).click()
  await expect(card.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT)

  await card.getByRole('button', { name: 'Generate again' }).click()
  await expect(card).toContainText('Queued with a new seed.')
  await card.getByRole('button', { name: 'Final quality' }).click()
  await expect(card).toContainText('Final quality queued.')
  expect(backend.shotRequests).toEqual([
    { prompt: PROMPT, duration: 3, quality: 'draft', variations: 1, basedOn: 'm-draft' },
    { prompt: PROMPT, duration: 3, quality: 'final', variations: 1, seed: 4242, basedOn: 'm-draft' },
  ])
  await expect(page.getByTestId('shot-job')).toHaveCount(2)

  // A Final clip has no "Final quality" button.
  backend.runShot(1, 'done')
  const finalCard = page.getByTestId('ai-shot').filter({ hasText: 'Final ·' })
  await expect(finalCard).toBeVisible()
  await expect(finalCard.getByRole('button', { name: 'Final quality' })).toHaveCount(0)
})

test('a failed shot shows ComfyUI’s reason', async ({ page }) => {
  const backend = await fakeBackend(page)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByRole('button', { name: 'Generate shot' }).click()
  await page.getByRole('dialog').getByLabel('Prompt').fill(PROMPT)
  await page.getByRole('dialog').getByRole('button', { name: 'Generate shot' }).click()
  backend.runShot(0, 'error')
  await expect(page.getByTestId('shot-job')).toContainText('CUDA out of memory')
})
