import { expect, test, type Page } from '@playwright/test'
import { fakeBackend, libraryItem } from './fakeBackend'

const SCRIPT = 'Every airplane window has a tiny hole in it. It keeps the window from fogging up.'

/** Colour of a pixel near the top-left of the preview (away from the captions). */
async function previewColour(page: Page): Promise<'red' | 'blue' | 'black' | 'other'> {
  return page.getByTestId('preview-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const [r, g, b] = canvas.getContext('2d')!.getImageData(60, 60, 1, 1).data
    if (r > 150 && g < 80 && b < 80) return 'red'
    if (b > 150 && r < 80 && g < 80) return 'blue'
    if (r < 20 && g < 20 && b < 20) return 'black'
    return 'other'
  })
}

async function playheadSeconds(page: Page): Promise<number> {
  const text = await page.getByRole('slider', { name: 'Seek' }).inputValue()
  return Number(text)
}

/** Plays, and pauses from inside the page as soon as the playhead passes `seconds`. */
async function playUntil(page: Page, seconds: number) {
  await page.getByRole('button', { name: 'Play' }).click()
  await page.evaluate(
    (target) =>
      new Promise<void>((resolve) => {
        const check = () => {
          const seek = document.querySelector<HTMLInputElement>('input[aria-label="Seek"]')!
          if (Number(seek.value) > target) {
            document.querySelector<HTMLButtonElement>('button[aria-label="Pause"]')!.click()
            resolve()
          } else requestAnimationFrame(check)
        }
        check()
      }),
    seconds,
  )
}

async function makeVoiceoverAndCaptions(page: Page) {
  await page.getByRole('textbox', { name: 'Script' }).fill(SCRIPT)
  await page.getByRole('button', { name: 'Generate AI read' }).click()
  await expect(page.getByText('AI read · Heart')).toBeVisible()
  await page.getByRole('button', { name: 'Generate captions' }).click()
  await expect(page.getByRole('button', { name: 'Regenerate captions' })).toBeVisible()
}

test('drag a clip from the library onto the timeline and play the preview', async ({ page }) => {
  await fakeBackend(page, { library: [libraryItem('m-red', { name: 'Red then blue' })] })
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await makeVoiceoverAndCaptions(page) // an 8 s voiceover

  await page.getByRole('tab', { name: 'Media' }).click()
  const card = page.getByTestId('library-item').filter({ hasText: 'Red then blue' })
  await expect(card).toContainText('180×320 · 2.0 s · Imported')
  await expect(card.getByText('Low res')).toBeVisible()

  // Drop it at the very start of the video track.
  const lane = page.getByTestId('video-lane')
  await card.dragTo(lane, { targetPosition: { x: 16, y: 20 } })

  const clip = page.getByTestId('timeline-clip')
  await expect(clip).toHaveCount(1)
  await expect(clip).toHaveAttribute('title', /Red then blue · 0:00\.00–0:02\.00/)
  // The rest of the 8 s voiceover has no clip: shown as a gap.
  await expect(page.getByTestId('timeline-gap')).toHaveCount(1)
  await expect(page.getByTestId('timeline-gap')).toHaveAttribute('title', 'No clip from 0:02.00 to 0:08.00')
  await expect(page.getByText('1 clip · 0:08 · 1080×1920')).toBeVisible()

  // The preview shows the clip's first frame, then plays it in step with the clock:
  // red for its first second, blue for its second, then the gap (black).
  await expect.poll(() => previewColour(page)).toBe('red')
  await playUntil(page, 1.3)
  expect(await playheadSeconds(page)).toBeLessThan(1.9)
  await expect.poll(() => previewColour(page)).toBe('blue')

  await playUntil(page, 2.3)
  await expect(page.getByText('No clip here: this part of the video is black')).toBeVisible()
  await expect.poll(() => previewColour(page)).toBe('black')

  // Captions are drawn on top of the clips while it plays (there is one at 0.6 s).
  await page.getByRole('slider', { name: 'Seek' }).fill('0.6')
  await expect.poll(() => previewColour(page)).toBe('red')
})

test('reorder, trim, split, delete and undo on the video track', async ({ page }) => {
  await fakeBackend(page, {
    library: [libraryItem('m-a', { name: 'Alpha' }), libraryItem('m-b', { name: 'Bravo', aiGenerated: true })],
  })
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await makeVoiceoverAndCaptions(page)
  await page.getByRole('tab', { name: 'Media' }).click()

  // "+" fills the first gap: Alpha 0-2, then Bravo 2-4.
  await page.getByRole('button', { name: 'Add “Alpha” to the timeline' }).click()
  await page.getByRole('button', { name: 'Add “Bravo” to the timeline' }).click()
  const alpha = page.getByRole('button', { name: 'Clip Alpha' })
  const bravo = page.getByRole('button', { name: 'Clip Bravo' })
  await expect(alpha).toHaveAttribute('title', /0:00\.00–0:02\.00/)
  await expect(bravo).toHaveAttribute('title', /0:02\.00–0:04\.00/)
  // Bravo is AI-generated: the top bar says so.
  await expect(page.getByTestId('ai-indicator')).toContainText('Contains AI · 1')

  // Drag Bravo onto Alpha's left half: they trade places.
  const a = (await alpha.boundingBox())!
  const b = (await bravo.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + 10, a.y + a.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(bravo).toHaveAttribute('title', /0:00\.00–0:02\.00/)
  await expect(alpha).toHaveAttribute('title', /0:02\.00–0:04\.00/)

  // Trim Alpha's end edge to the left: a gap opens after it.
  const trimmed = (await alpha.boundingBox())!
  await page.mouse.move(trimmed.x + trimmed.width - 3, trimmed.y + trimmed.height / 2)
  await page.mouse.down()
  await page.mouse.move(trimmed.x + trimmed.width / 2, trimmed.y + trimmed.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect(alpha).toHaveAttribute('title', /0:02\.00–0:03\.\d\d/)

  // Split Bravo at 1 s, delete the second half, then undo the delete.
  await page.getByRole('slider', { name: 'Seek' }).fill('1')
  await page.getByRole('button', { name: 'Split' }).click()
  await expect(page.getByRole('button', { name: 'Clip Bravo' })).toHaveCount(2)
  await page.getByRole('button', { name: 'Clip Bravo' }).nth(1).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Clip Bravo' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('button', { name: 'Clip Bravo' })).toHaveCount(2)

  // Fit to voiceover closes every gap up to the 8 s end.
  await page.getByRole('button', { name: 'Fit to voiceover' }).click()
  await expect(page.getByTestId('timeline-gap')).toHaveCount(0)
})
