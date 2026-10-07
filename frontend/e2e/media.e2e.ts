import { expect, test } from '@playwright/test'
import { fakeBackend, MISSING_KEY, pexelsResult } from './fakeBackend'

test('Pexels search shows the real reason when the key is missing', async ({ page }) => {
  await fakeBackend(page, { pexels: null })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByRole('searchbox', { name: 'Search Pexels' }).fill('ocean')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const media = page.getByRole('complementary', { name: 'Script, media and ranking' })
  await expect(media.getByRole('alert')).toContainText(MISSING_KEY)
})

test('add a Pexels result to the library', async ({ page }) => {
  await fakeBackend(page, { pexels: [pexelsResult(101, 'Waves crashing on the shore'), pexelsResult(102, 'City at night')] })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByRole('searchbox', { name: 'Search Pexels' }).fill('ocean')
  await page.getByRole('button', { name: 'Search', exact: true }).click()

  const results = page.getByRole('list', { name: 'Pexels results' }).getByRole('listitem')
  await expect(results).toHaveCount(2)
  await expect(results.first()).toContainText('1080×1920')
  await page.getByRole('button', { name: 'Add “Waves crashing on the shore” to the library' }).click()
  await expect(results.first()).toContainText('In library')

  const card = page.getByTestId('library-item').filter({ hasText: 'Waves crashing on the shore' })
  await expect(card).toContainText('1080×1920 · 2.0 s · Pexels')
  await expect(card.getByRole('link', { name: 'by Jane Doe on Pexels' })).toHaveAttribute(
    'href',
    'https://www.pexels.com/video/waves-crashing-on-the-shore-101/',
  )
  await expect(card.getByText('Low res')).toHaveCount(0)
})

test('imports tick AI-generated for ComfyUI outputs, and the flag can be changed later', async ({ page }) => {
  await fakeBackend(page)
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await page.getByRole('tab', { name: 'Media' }).click()

  const clip = { mimeType: 'video/webm', buffer: Buffer.from('fake') }
  await page.getByLabel('Choose clips or images to import').setInputFiles([
    { name: 'LTX_2_5_t2v_00017_.mp4', ...clip },
    { name: 'beach.webm', ...clip },
  ])
  const staged = page.getByRole('list', { name: 'Files to import' }).getByRole('listitem')
  await expect(staged).toHaveCount(2)
  await expect(staged.nth(0).getByRole('checkbox', { name: 'AI-generated' })).toBeChecked()
  await expect(staged.nth(1).getByRole('checkbox', { name: 'AI-generated' })).not.toBeChecked()
  await page.getByRole('button', { name: 'Import 2 files' }).click()

  const ltx = page.getByTestId('library-item').filter({ hasText: 'LTX_2_5_t2v_00017_' })
  const beach = page.getByTestId('library-item').filter({ hasText: 'beach' })
  await expect(ltx.getByText('AI', { exact: true })).toBeVisible()
  await expect(beach.getByText('AI', { exact: true })).toHaveCount(0)

  // On the timeline, the AI clip marks the project.
  await page.getByRole('button', { name: 'Add “LTX_2_5_t2v_00017_” to the timeline' }).click()
  await expect(page.getByTestId('ai-indicator')).toContainText('Contains AI · 1')

  // Unticking the flag in the library clears it.
  await ltx.locator('label', { hasText: 'AI-generated' }).click()
  await expect(ltx.getByRole('checkbox', { name: 'AI-generated' })).not.toBeChecked()
  await expect(page.getByTestId('ai-indicator')).toHaveCount(0)
})
