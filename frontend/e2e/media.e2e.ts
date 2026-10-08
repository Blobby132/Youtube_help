import { expect, test } from '@playwright/test'
import { fakeBackend, MISSING_KEY, pexelsResult, stockResult } from './fakeBackend'

test('without a key, search shows how to add one and the real reason', async ({ page }) => {
  await fakeBackend(page)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Media' }).click()
  const media = page.getByRole('complementary', { name: 'Script, media, scenes and ranking' })
  await expect(media.getByRole('status').filter({ hasText: 'PIXABAY_API_KEY' })).toBeVisible()
  await expect(media.getByRole('button', { name: 'Auto-fill from script' })).toBeDisabled()
  await page.getByRole('searchbox', { name: 'Search Pixabay' }).fill('ocean')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(media.getByRole('alert')).toContainText(MISSING_KEY.pixabay)
})

test('Pixabay results say where they come from and filter by orientation', async ({ page }) => {
  const backend = await fakeBackend(page, {
    pixabay: [stockResult('pixabay', 201, 'Ocean, waves', 'portrait'), stockResult('pixabay', 202, 'Beach, sunset', 'landscape')],
  })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Media' }).click()
  // Only Pixabay has a key: no source switch.
  await expect(page.getByRole('radiogroup', { name: 'Stock video source' })).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search Pixabay' }).fill('ocean')
  await page.getByRole('button', { name: 'Search', exact: true }).click()

  const results = page.getByRole('list', { name: 'Pixabay results' }).getByRole('listitem')
  await expect(results).toHaveCount(1)
  await expect(results.first()).toContainText('Portrait')
  await expect(page.getByTestId('stock-credit')).toContainText(/videos? from Pixabay/)

  await page.getByRole('radio', { name: 'Landscape' }).click()
  await expect(results).toHaveCount(1)
  await expect(results.first()).toContainText('Landscape')
  await page.getByRole('radio', { name: 'Any' }).click()
  await expect(results).toHaveCount(2)
  expect(backend.searched.map((s) => s.orientation)).toEqual(['portrait', 'landscape', 'any'])

  await page.getByRole('button', { name: 'Add “Ocean, waves” to the library' }).click()
  const card = page.getByTestId('library-item').filter({ hasText: 'Ocean, waves' })
  await expect(card).toContainText('1080×1920 · 2.0 s · Pixabay')
  await expect(card.getByRole('link', { name: 'by SeaFilms on Pixabay' })).toHaveAttribute('href', 'https://pixabay.com/videos/id-201/')
})

test('a used-up Pixabay rate limit shows when you can search again', async ({ page }) => {
  const backend = await fakeBackend(page, { pixabay: [stockResult('pixabay', 201, 'Ocean, waves')] })
  backend.limits.pixabay = 1
  await page.goto('/')
  await page.getByRole('tab', { name: 'Media' }).click()
  const box = page.getByRole('searchbox', { name: 'Search Pixabay' })
  const searchButton = page.getByRole('search').getByRole('button')
  await box.fill('ocean')
  await searchButton.click()
  await expect(page.getByRole('list', { name: 'Pixabay results' }).getByRole('listitem')).toHaveCount(1)

  await box.fill('beach')
  await searchButton.click()
  const warning = page.getByRole('alert').filter({ hasText: 'rate limit is used up' })
  await expect(warning).toContainText('You can search Pixabay again in 0:0')
  await expect(searchButton).toBeDisabled()
  await expect(searchButton).toHaveText(/0:0\d/)

  // The countdown ends and Search works again.
  backend.limits.pixabay = null
  await expect(searchButton).toHaveText('Search', { timeout: 6000 })
  await expect(warning).toHaveCount(0)
  await searchButton.click()
  await expect(page.getByRole('list', { name: 'Pixabay results' })).toBeVisible()
})

test('with both keys, a switch picks the source', async ({ page }) => {
  const backend = await fakeBackend(page, {
    pexels: [pexelsResult(101, 'Waves crashing on the shore')],
    pixabay: [stockResult('pixabay', 201, 'Ocean, waves')],
  })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Media' }).click()
  const sources = page.getByRole('radiogroup', { name: 'Stock video source' })
  await expect(sources.getByRole('radio')).toHaveText(['Pixabay', 'Pexels'])

  await page.getByRole('searchbox', { name: 'Search Pixabay' }).fill('ocean')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByTestId('stock-credit')).toContainText(/videos? from Pixabay/)

  // Switching repeats the search on the other source.
  await sources.getByRole('radio', { name: 'Pexels' }).click()
  await expect(page.getByRole('list', { name: 'Pexels results' }).getByRole('listitem')).toHaveCount(1)
  await expect(page.getByTestId('stock-credit')).toContainText(/videos? from Pexels/)
  expect(backend.searched.map((s) => s.source)).toEqual(['pixabay', 'pexels'])

  // The choice is remembered.
  await page.reload()
  await page.getByRole('tab', { name: 'Media' }).click()
  await expect(page.getByRole('searchbox', { name: 'Search Pexels' })).toBeVisible()
})

test('add a Pexels result to the library', async ({ page }) => {
  await fakeBackend(page, { pexels: [pexelsResult(101, 'Waves crashing on the shore'), pexelsResult(102, 'City at night')] })
  // Only Pexels has a key here.
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
