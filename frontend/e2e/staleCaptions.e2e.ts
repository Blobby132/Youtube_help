import { expect, test } from '@playwright/test'
import { fakeBackend } from './fakeBackend'

const SCRIPT =
  'Every airplane window has a tiny hole in it. And it is not a manufacturing mistake. ' +
  'It is called a breather hole, and it keeps the window from fogging up.'

// Bug report: generate a voiceover, generate captions, change one word in the script,
// regenerate the voiceover. The Captions panel must say the captions are out of date,
// visibly, even when it is scrolled down to the caption list (where you fix typos).
test('out-of-date captions warning is visible after the voiceover changes', async ({ page }) => {
  await fakeBackend(page)
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()

  const script = page.getByRole('textbox', { name: 'Script' })
  await script.fill(SCRIPT)
  await page.getByRole('button', { name: 'Generate AI read' }).click()
  await expect(page.getByText('AI read · Heart')).toBeVisible()

  await page.getByRole('button', { name: 'Generate captions' }).click()
  await expect(page.getByRole('button', { name: 'Regenerate captions' })).toBeVisible()

  // Fix a "typo" in the last caption: this scrolls the Captions panel down to the list.
  const lastCaption = page.locator('ol li input').last()
  await lastCaption.click()
  await lastCaption.fill('up!')
  await lastCaption.press('Enter')

  await script.fill(SCRIPT.replace('tiny', 'small'))
  await page.getByRole('button', { name: 'Regenerate AI read' }).click()
  await expect(page.getByText(/script changed after this read/)).toHaveCount(0)

  const warning = page.getByText(/voiceover changed after these captions/)
  await expect(warning).toBeVisible()
  await expect(warning).toBeInViewport()

  // Regenerating from the warning (and confirming that caption edits will be replaced)
  // brings the captions up to date and clears it.
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Regenerate captions' }).first().click()
  await expect(warning).toHaveCount(0)
})
