import { expect, test, type Locator, type Page } from '@playwright/test'
import { fakeBackend, libraryItem, wideItem } from './fakeBackend'

const SCRIPT = 'Every airplane window has a tiny hole in it. It keeps the window from fogging up.'

type Colour = 'red' | 'blue' | 'green' | 'magenta' | 'black' | 'other'

/** Colour of one pixel of the 1080x1920 preview. */
async function pixel(page: Page, x: number, y: number): Promise<Colour> {
  return page.getByTestId('preview-canvas').evaluate(
    (canvas: HTMLCanvasElement, [px, py]) => {
      const [r, g, b] = canvas.getContext('2d')!.getImageData(px, py, 1, 1).data
      if (r > 150 && g < 80 && b > 150) return 'magenta'
      if (r > 150 && g < 80 && b < 80) return 'red'
      if (b > 150 && r < 80 && g < 80) return 'blue'
      if (g > 120 && r < 80 && b < 80) return 'green'
      if (r < 20 && g < 20 && b < 20) return 'black'
      return 'other'
    },
    [x, y],
  )
}

/** How many pixels in a band across the frame have the default rank number colour (#ffd60a). */
async function yellowPixels(page: Page, top: number, height: number): Promise<number> {
  return page.getByTestId('preview-canvas').evaluate(
    (canvas: HTMLCanvasElement, [y, h]) => {
      const data = canvas.getContext('2d')!.getImageData(0, y, canvas.width, h).data
      let count = 0
      for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] > 170 && data[i + 2] < 90) count++
      return count
    },
    [top, height],
  )
}

async function makeVoiceover(page: Page) {
  await page.getByRole('textbox', { name: 'Script' }).fill(SCRIPT)
  await page.getByRole('button', { name: 'Generate AI read' }).click()
  await expect(page.getByText('AI read · Heart')).toBeVisible()
}

/** Checks an entry's start and end fields in the Ranking tab, given as "0:00.00–0:02.00". */
async function expectTime(entry: Locator, range: string) {
  const [start, end] = range.split('–')
  await expect(entry.getByRole('textbox', { name: /^Start of #/ })).toHaveValue(start)
  await expect(entry.getByRole('textbox', { name: /^End of #/ })).toHaveValue(end)
}

const seek = (page: Page, seconds: number) => page.getByRole('slider', { name: 'Seek' }).fill(String(seconds))

test('Fit inside shows the whole clip over the background, and it is saved', async ({ page }) => {
  await fakeBackend(page, { library: [wideItem('m-wide', { name: 'Wide field' })] })
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await makeVoiceover(page)
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByRole('button', { name: 'Add “Wide field” to the timeline' }).click()
  await seek(page, 0.5)

  // Fill (the default): the green clip covers the whole frame.
  const settings = page.getByRole('complementary', { name: 'Clip settings' })
  await expect(settings.getByRole('radio', { name: 'Fill' })).toHaveAttribute('aria-checked', 'true')
  await expect(settings.getByRole('slider', { name: 'Crop position' })).toBeVisible()
  await expect.poll(() => pixel(page, 60, 60)).toBe('green')

  // Fit inside: the whole 16:9 picture across the middle, the background above and below.
  await settings.getByRole('radio', { name: 'Fit inside' }).click()
  await expect(settings.getByRole('slider', { name: 'Crop position' })).toHaveCount(0)
  await expect(settings).toContainText('The whole picture shows, with the background around it.')
  // Zoomed in, the clip has room for its badges.
  await page.getByRole('slider', { name: 'Timeline zoom' }).fill('1')
  await expect(page.getByRole('button', { name: 'Clip Wide field' }).getByText('Fit', { exact: true })).toBeVisible()
  await expect.poll(() => pixel(page, 540, 960)).toBe('green')

  // A solid magenta background shows above and below the picture.
  await settings.getByRole('button', { name: 'Background settings' }).click()
  const canvasTab = page.getByRole('complementary', { name: 'Captions, canvas and title' })
  await expect(canvasTab).toContainText('Fills the frame around clips set to Fit inside (1 on the timeline).')
  await canvasTab.getByRole('radio', { name: 'Solid color' }).click()
  await canvasTab.getByLabel('Color', { exact: true }).fill('#ff00ff')
  await expect.poll(() => pixel(page, 60, 60)).toBe('magenta')
  await expect.poll(() => pixel(page, 540, 960)).toBe('green')

  // Blurred clip: a blurred copy of the (all green) clip fills the frame instead.
  await canvasTab.getByRole('radio', { name: 'Blurred clip' }).click()
  await expect.poll(() => pixel(page, 60, 60)).toBe('green')

  // Saved with the project; Undo goes back to Fill.
  await canvasTab.getByRole('radio', { name: 'Solid color' }).click()
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await page.reload()
  await seek(page, 0.5)
  await expect.poll(() => pixel(page, 60, 60)).toBe('magenta')
  await page.getByRole('button', { name: 'Clip Wide field' }).click()
  await page.getByRole('complementary', { name: 'Clip settings' }).getByRole('radio', { name: 'Fill' }).click()
  await expect.poll(() => pixel(page, 60, 60)).toBe('green')
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => pixel(page, 60, 60)).toBe('magenta')
})

test('the title shows in a bar at the top, for the whole video or its first seconds', async ({ page }) => {
  await fakeBackend(page, { library: [wideItem('m-wide', { name: 'Wide field' })] })
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await makeVoiceover(page)
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByRole('button', { name: 'Add “Wide field” to the timeline' }).click()
  await seek(page, 1.5)

  const canvasTab = page.getByRole('complementary', { name: 'Captions, canvas and title' })
  await canvasTab.getByRole('tab', { name: 'Canvas & title' }).click()
  // The checkbox itself is visually hidden behind its styled box.
  await canvasTab.getByRole('checkbox', { name: 'On' }).dispatchEvent('click')
  await canvasTab.getByLabel('Text', { exact: true }).fill('Top 3 airplane facts')
  await canvasTab.getByLabel('Bar color').fill('#0000ff')

  // The bar spans the frame's width, from 150 px down.
  await expect.poll(() => pixel(page, 20, 160)).toBe('blue')
  await expect.poll(() => pixel(page, 20, 100)).toBe('green')

  // Shown for the first second only: gone at 1.5 s, back at 0.5 s.
  await canvasTab.getByRole('radio', { name: 'First seconds' }).click()
  await canvasTab.getByRole('slider', { name: 'Seconds' }).fill('1')
  await expect.poll(() => pixel(page, 20, 160)).toBe('green')
  await seek(page, 0.5)
  await expect.poll(() => pixel(page, 20, 160)).toBe('blue')

  // Turned off: no bar.
  await canvasTab.getByRole('checkbox', { name: 'On' }).dispatchEvent('click')
  await expect(canvasTab.getByRole('checkbox', { name: 'On' })).not.toBeChecked()
  await expect.poll(() => pixel(page, 20, 160)).toBe('green')
})

test('ranking entries have their own times: added from the selection or sentence, resized on the Ranks lane', async ({ page }) => {
  await fakeBackend(page, {
    library: [libraryItem('m-a', { name: 'Alpha' }), libraryItem('m-b', { name: 'Bravo' })],
  })
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  // An 8 s voiceover; the fake captions give each word 0.3 s, so the first sentence runs
  // 0-2.68 s and the second ("It keeps the window from fogging up.") 2.7-4.78 s.
  await makeVoiceover(page)
  await page.getByRole('button', { name: 'Generate captions' }).click()
  await expect(page.getByRole('button', { name: 'Regenerate captions' })).toBeVisible()
  await page.getByRole('tab', { name: 'Media' }).click()
  // Alpha 0-2 s, Bravo 2-4 s.
  await page.getByRole('button', { name: 'Add “Alpha” to the timeline' }).click()
  await page.getByRole('button', { name: 'Add “Bravo” to the timeline' }).click()

  const left = page.getByRole('complementary', { name: 'Script, media and ranking' })
  await left.getByRole('tab', { name: 'Ranking' }).click()
  await expect(left.getByRole('radio', { name: 'Count down 5→1' })).toHaveAttribute('aria-checked', 'true')

  // With Alpha selected, a new entry takes Alpha's span.
  await page.getByRole('button', { name: 'Clip Alpha' }).click()
  await left.getByRole('button', { name: 'Add entry' }).click()
  await expect(left.getByLabel('Label of #1')).toBeFocused()
  await left.getByLabel('Label of #1').fill('Boeing 747')
  const entries = left.getByTestId('rank-entry')
  await expectTime(entries.nth(0), '0:00.00–0:02.00')

  // Alpha is already used, so the next one takes the sentence under the playhead.
  await seek(page, 3.5)
  await left.getByRole('button', { name: 'Add entry' }).click()
  await left.getByLabel('Label of #1').fill('Airbus A380')
  await expect(entries).toHaveCount(2)
  await expect(left.getByRole('radio', { name: 'Count down 2→1' })).toBeVisible()
  await expect(left.getByLabel('Label of #2')).toHaveValue('Boeing 747')
  await expectTime(entries.nth(1), '0:02.70–0:04.78')
  const blocks = page.getByTestId('rank-block')
  await expect(blocks).toHaveText(['#2 Boeing 747', '#1 Airbus A380'])

  // The rank number is drawn at the top during its time, and not in the gap between.
  await seek(page, 1)
  await expect.poll(() => yellowPixels(page, 220, 200)).toBeGreaterThan(200)
  await seek(page, 2.4)
  await expect.poll(() => yellowPixels(page, 220, 200)).toBe(0)

  // Dragging #1's start edge far left stops at #2's end: entries never overlap.
  const first = (await blocks.nth(0).boundingBox())!
  const pxPerSecond = first.width / 2
  let box = (await blocks.nth(1).boundingBox())!
  await page.mouse.move(box.x + 3, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 2 * pxPerSecond, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await expectTime(entries.nth(1), '0:02.00–0:04.78')

  // Its end edge snaps to the end of Bravo (a clip edge) at 4 s.
  box = (await blocks.nth(1).boundingBox())!
  const snapLine = page.locator('[class*="snapLine"]')
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 3 - 0.78 * pxPerSecond + 1, box.y + box.height / 2, { steps: 6 })
  await expect(snapLine).toHaveText('clip')
  await page.mouse.up()
  await expect(snapLine).toHaveCount(0)
  await expectTime(entries.nth(1), '0:02.00–0:04.00')

  // Splitting and deleting clips leaves the entries' times alone.
  await seek(page, 1)
  await page.getByRole('button', { name: 'Split' }).click()
  await page.getByRole('button', { name: 'Clip Bravo' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByTestId('timeline-clip')).toHaveCount(2)
  await expect(blocks).toHaveText(['#2 Boeing 747', '#1 Airbus A380'])
  await expectTime(entries.nth(0), '0:00.00–0:02.00')
  await expectTime(entries.nth(1), '0:02.00–0:04.00')
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByTestId('timeline-clip')).toHaveCount(2)
  await expectTime(entries.nth(1), '0:02.00–0:04.00')

  // Moving Airbus's entry first puts the count out of order.
  await left.getByRole('button', { name: 'Move #1 up' }).click()
  await expect(left.getByLabel('Label of #2')).toHaveValue('Airbus A380')
  await expect(entries.nth(1)).toContainText('#1 plays before #2: move it up, or give it a later time.')
  await expect(blocks.filter({ hasText: '#1 Boeing 747' })).toHaveAttribute('title', /plays out of order/)

  // Dragging it back down puts it right again.
  const below = (await entries.nth(1).boundingBox())!
  await entries.nth(0).getByTitle('Drag to reorder').dragTo(entries.nth(1), { targetPosition: { x: 40, y: below.height - 6 } })
  await expect(left.getByLabel('Label of #2')).toHaveValue('Boeing 747')
  await expect(left.getByText(/plays before/)).toHaveCount(0)

  // Counting up renumbers them.
  await left.getByRole('radio', { name: 'Count up 1→2' }).click()
  await expect(blocks).toHaveText(['#1 Boeing 747', '#2 Airbus A380'])

  // Saved with the project.
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await page.reload()
  await page.getByRole('complementary', { name: 'Script, media and ranking' }).getByRole('tab', { name: 'Ranking' }).click()
  await expect(page.getByTestId('rank-block')).toHaveText(['#1 Boeing 747', '#2 Airbus A380'])
  await expectTime(page.getByTestId('rank-entry').nth(0), '0:00.00–0:02.00')
  await expectTime(page.getByTestId('rank-entry').nth(1), '0:02.00–0:04.00')

  // Removing an entry renumbers the rest.
  await page.getByRole('button', { name: 'Remove #1' }).click()
  await expect(page.getByTestId('rank-block')).toHaveText(['#1 Airbus A380'])
})

test('Undo and Redo cover every ranking edit, and times can be typed', async ({ page }) => {
  await fakeBackend(page, { library: [] })
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  const left = page.getByRole('complementary', { name: 'Script, media and ranking' })
  await left.getByRole('tab', { name: 'Ranking' }).click()
  const entries = left.getByTestId('rank-entry')
  const addButton = left.getByRole('button', { name: 'Add entry' })
  const undoButton = page.getByRole('button', { name: 'Undo' })
  const redoButton = page.getByRole('button', { name: 'Redo' })

  // Undo removes an added entry, from the button...
  await addButton.click()
  await expect(entries).toHaveCount(1)
  await undoButton.click()
  await expect(entries).toHaveCount(0)
  await redoButton.click()
  await expect(entries).toHaveCount(1)
  await undoButton.click()
  await expect(entries).toHaveCount(0)

  // ...and from Ctrl+Z, though the new entry's label has the focus.
  await addButton.click()
  await expect(left.getByLabel('Label of #1')).toBeFocused()
  await page.keyboard.press('Control+z')
  await expect(entries).toHaveCount(0)
  await page.keyboard.press('Control+Shift+z')
  await expect(entries).toHaveCount(1)
  await expectTime(entries.nth(0), '0:00.00–0:03.00')

  // Typing a label undoes as one step, Ctrl+Z in the label included.
  const label = left.getByLabel('Label of #1')
  await label.pressSequentially('Boeing 747')
  await page.keyboard.press('Control+z')
  await expect(label).toHaveValue('')
  await expect(entries).toHaveCount(1)
  await page.keyboard.press('Control+y')
  await expect(label).toHaveValue('Boeing 747')

  // A second entry goes right after the first: #2 then #1, counting down.
  await addButton.click()
  await expect(entries).toHaveCount(2)
  await expectTime(entries.nth(1), '0:03.00–0:06.00')

  // Typed times: Enter applies, as seconds or as minutes and seconds.
  const field = (index: number, edge: 'Start' | 'End') => entries.nth(index).getByRole('textbox', { name: new RegExp(`^${edge} of #`) })
  const message = left.getByTestId('rank-time-message')
  await field(0, 'End').fill('2.5')
  await field(0, 'End').press('Enter')
  await expectTime(entries.nth(0), '0:00.00–0:02.50')
  await field(0, 'Start').fill('0:00.50')
  await field(0, 'Start').press('Enter')
  await expectTime(entries.nth(0), '0:00.50–0:02.50')
  await expect(message).toHaveCount(0)

  // Escape cancels.
  await field(0, 'Start').fill('1')
  await field(0, 'Start').press('Escape')
  await expect(field(0, 'Start')).toHaveValue('0:00.50')

  // Ctrl+Z in the field (with nothing typed) undoes the last typed time.
  await page.keyboard.press('Control+z')
  await expectTime(entries.nth(0), '0:00.00–0:02.50')
  await redoButton.click()
  await expectTime(entries.nth(0), '0:00.50–0:02.50')

  // A time that can't be used shows why and changes nothing; the text stays to fix it.
  await field(0, 'End').fill('abc')
  await field(0, 'End').press('Enter')
  await expect(message).toHaveText('“abc” isn’t a time. Type minutes and seconds like 0:03.04, or seconds like 3.04.')
  await expect(field(0, 'End')).toHaveValue('abc')
  await field(0, 'End').press('Escape')
  await expect(message).toHaveCount(0)
  await expectTime(entries.nth(0), '0:00.50–0:02.50')

  await field(0, 'Start').fill('0:05')
  await field(0, 'Start').press('Enter')
  await expect(message).toHaveText('The start has to be before the end (0:02.50). To move the entry later, change its end first.')
  await field(0, 'Start').press('Escape')

  await field(0, 'End').fill('4')
  await field(0, 'End').press('Enter')
  await expect(message).toHaveText('That overlaps #1 (0:03.00–0:06.00). Entries can’t overlap.')
  await field(0, 'End').press('Escape')

  await field(1, 'End').fill('0:02')
  await field(1, 'End').press('Enter')
  await expect(message).toHaveText('The end has to be after the start (0:03.00). To move the entry earlier, change its start first.')
  await field(1, 'End').press('Escape')
  await expectTime(entries.nth(0), '0:00.50–0:02.50')
  await expectTime(entries.nth(1), '0:03.00–0:06.00')

  // Leaving a field applies what was typed.
  await field(1, 'End').fill('7')
  await left.getByRole('heading', { name: 'Entries' }).click()
  await expectTime(entries.nth(1), '0:03.00–0:07.00')
  await undoButton.click()
  await expectTime(entries.nth(1), '0:03.00–0:06.00')

  // Dragging an edge on the Ranks lane undoes too.
  const block = page.getByTestId('rank-block').nth(1)
  const box = (await block.boundingBox())!
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect(field(1, 'End')).not.toHaveValue('0:06.00')
  const dragged = await field(1, 'End').inputValue()
  await undoButton.click()
  await expect(field(1, 'End')).toHaveValue('0:06.00')
  await redoButton.click()
  await expect(field(1, 'End')).toHaveValue(dragged)

  // Reordering, the count's direction and removing undo too.
  await left.getByRole('button', { name: 'Move #1 up' }).click()
  await expect(left.getByLabel('Label of #1')).toHaveValue('Boeing 747')
  await undoButton.click()
  await expect(left.getByLabel('Label of #2')).toHaveValue('Boeing 747')
  await left.getByRole('radio', { name: 'Count up 1→2' }).click()
  await expect(left.getByRole('radio', { name: 'Count up 1→2' })).toHaveAttribute('aria-checked', 'true')
  await undoButton.click()
  await expect(left.getByRole('radio', { name: 'Count down 2→1' })).toHaveAttribute('aria-checked', 'true')
  await left.getByRole('button', { name: 'Remove #2' }).click()
  await expect(entries).toHaveCount(1)
  await undoButton.click()
  await expect(entries).toHaveCount(2)
  await expect(left.getByLabel('Label of #2')).toHaveValue('Boeing 747')
})
