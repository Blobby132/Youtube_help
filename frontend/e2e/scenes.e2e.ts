import { expect, test, type Locator, type Page } from '@playwright/test'
import { fakeBackend, stockResult } from './fakeBackend'

// 24 words. The fake voiceover is 8 s long; the fake captions time word i at i × 0.3 s.
const SCRIPT = 'Every airplane window has a tiny hole in it. It keeps the window from fogging up. The hole lets air move between the panes.'
const PROMPT = 'Close-up of an airplane window at sunrise, clouds drifting past'

async function makeVoiceover(page: Page) {
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await page.getByRole('textbox', { name: 'Script' }).fill(SCRIPT)
  await page.getByRole('button', { name: 'Generate AI read' }).click()
  await expect(page.getByText('AI read · Heart')).toBeVisible()
}

async function makeCaptions(page: Page) {
  await page.getByRole('button', { name: 'Generate captions' }).click()
  await expect(page.getByRole('button', { name: 'Regenerate captions' })).toBeVisible()
}

async function openScenes(page: Page) {
  await page.getByRole('tab', { name: 'Scenes' }).click()
  return page.getByRole('complementary', { name: 'Script, media, scenes and ranking' })
}

/** A scene card's start and end fields, as "0:00.00–0:03.00". */
async function expectTime(scene: Locator, range: string) {
  const [start, end] = range.split('–')
  await expect(scene.getByRole('textbox', { name: /^Start of scene/ })).toHaveValue(start)
  await expect(scene.getByRole('textbox', { name: /^End of scene/ })).toHaveValue(end)
}

async function expectTimes(page: Page, ranges: string[]) {
  const scenes = page.getByTestId('scene')
  await expect(scenes).toHaveCount(ranges.length)
  for (const [i, range] of ranges.entries()) await expectTime(scenes.nth(i), range)
}

const seek = (page: Page, seconds: number) => page.getByRole('slider', { name: 'Seek' }).fill(String(seconds))
const undo = (page: Page) => page.getByRole('button', { name: 'Undo' }).click()

test('scenes from the script: estimated without captions, timed by them with captions, and recreating asks first', async ({ page }) => {
  await fakeBackend(page)
  await makeVoiceover(page)
  const panel = await openScenes(page)
  await expect(page.getByTestId('scene-timing')).toContainText('No captions yet, so times are estimated')

  // Without captions the 24 words are spread over the 8 s voiceover: a sentence per scene.
  await panel.getByRole('button', { name: 'Create scenes from script' }).click()
  const estimated = ['0:00.00–0:03.00', '0:03.00–0:05.33', '0:05.33–0:08.00']
  await expectTimes(page, estimated)
  await expect(page.getByTestId('scene-narration')).toHaveText([
    'Every airplane window has a tiny hole in it.',
    'It keeps the window from fogging up.',
    'The hole lets air move between the panes.',
  ])
  await expect(page.getByTestId('scene-block')).toHaveText(['1', '2', '3'])

  // With captions, their word times. Recreating asks first; saying no changes nothing.
  await makeCaptions(page)
  await expect(page.getByTestId('scene-timing')).toHaveText('Timed with the captions’ words.')
  const questions: string[] = []
  page.once('dialog', (dialog) => {
    questions.push(dialog.message())
    void dialog.dismiss()
  })
  await panel.getByRole('button', { name: 'Create scenes from script' }).click()
  await expectTimes(page, estimated)
  expect(questions).toEqual(['Replace the 3 scenes with new ones from the script? Undo (Ctrl+Z) brings them back. Previews you made are kept.'])

  page.once('dialog', (dialog) => void dialog.accept())
  await panel.getByRole('button', { name: 'Create scenes from script' }).click()
  await expectTimes(page, ['0:00.00–0:02.70', '0:02.70–0:04.80', '0:04.80–0:08.00'])

  // Undo brings the earlier scenes back; Redo the new ones.
  await undo(page)
  await expectTimes(page, estimated)
  await page.getByRole('button', { name: 'Redo' }).click()
  await expectTimes(page, ['0:00.00–0:02.70', '0:02.70–0:04.80', '0:04.80–0:08.00'])
})

test('scene times: typed, dragged with snapping, split, merge, add and delete, all on Undo', async ({ page }) => {
  const backend = await fakeBackend(page)
  await makeVoiceover(page)
  await makeCaptions(page)
  const panel = await openScenes(page)
  await panel.getByRole('button', { name: 'Create scenes from script' }).click()
  const original = ['0:00.00–0:02.70', '0:02.70–0:04.80', '0:04.80–0:08.00']
  await expectTimes(page, original)
  const scenes = page.getByTestId('scene')

  // A typed end moves the start of the next scene, which shares the edge.
  const end1 = scenes.nth(0).getByRole('textbox', { name: 'End of scene 1' })
  await end1.fill('2.4')
  await end1.press('Enter')
  await expectTimes(page, ['0:00.00–0:02.40', '0:02.40–0:04.80', '0:04.80–0:08.00'])

  // A time it can't use says why and changes nothing.
  const start3 = scenes.nth(2).getByRole('textbox', { name: 'Start of scene 3' })
  await start3.fill('0:01.00')
  await start3.press('Enter')
  await expect(scenes.nth(2).getByTestId('scene-time-message')).toHaveText(
    'That leaves scene 2 (0:02.40–0:04.80) shorter than 0.5 s. Change or delete that scene first.',
  )
  await start3.press('Escape')
  await expectTime(scenes.nth(2), '0:04.80–0:08.00')

  // Dragging scene 3's start edge snaps to a caption change, and scene 2's end follows.
  const blocks = page.getByTestId('scene-block')
  const box = (await blocks.nth(2).boundingBox())!
  const pxPerSecond = box.width / 3.2
  const snapLine = page.locator('[class*="snapLine"]')
  await page.mouse.move(box.x + 3, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 3 - 0.27 * pxPerSecond, box.y + box.height / 2, { steps: 6 })
  await expect(snapLine).toHaveText('caption')
  await page.mouse.up()
  await expectTimes(page, ['0:00.00–0:02.40', '0:02.40–0:04.50', '0:04.50–0:08.00'])

  // Split at the playhead, merge back, delete, and add a scene in the free time.
  await seek(page, 1)
  await panel.getByRole('button', { name: 'Split scene 1' }).click()
  await expectTimes(page, ['0:00.00–0:01.00', '0:01.00–0:02.40', '0:02.40–0:04.50', '0:04.50–0:08.00'])
  await panel.getByRole('button', { name: 'Merge scene 1 with the next' }).click()
  await expectTimes(page, ['0:00.00–0:02.40', '0:02.40–0:04.50', '0:04.50–0:08.00'])
  await panel.getByRole('button', { name: 'Delete scene 2' }).click()
  await expectTimes(page, ['0:00.00–0:02.40', '0:04.50–0:08.00'])
  await seek(page, 3)
  await panel.getByRole('button', { name: 'Add scene' }).click()
  await expectTimes(page, ['0:00.00–0:02.40', '0:03.00–0:04.50', '0:04.50–0:08.00'])

  // Typing undoes as one step; Ctrl+Z in a scene's field undoes scene edits too.
  await panel.getByLabel('Visual description of scene 1').fill('A tiny hole in a plane window')
  await panel.getByLabel('Visual description of scene 1').press('Control+z')
  await expect(panel.getByLabel('Visual description of scene 1')).toHaveValue('')
  for (let i = 0; i < 6; i++) await undo(page)
  await expectTimes(page, original)

  // Scene edits are saved with the project.
  await page.getByRole('button', { name: 'Redo' }).click()
  await expect.poll(() => [...backend.projects.values()].map((p) => (p.scenes as { end: number }[])[0]?.end)).toEqual([2.4])
})

test('AI scene previews: generate, follow, choose, retry one, and keep them across a reload', async ({ page }) => {
  const backend = await fakeBackend(page)
  await makeVoiceover(page)
  const panel = await openScenes(page)
  await panel.getByRole('button', { name: 'Create scenes from script' }).click()
  const scene = page.getByTestId('scene').first()
  const button = scene.getByRole('button', { name: 'Generate previews' })
  await expect(button).toBeDisabled() // no prompt yet
  await scene.getByLabel('ComfyUI prompt of scene 1').fill(PROMPT)
  await expect(scene.getByRole('radiogroup', { name: 'Previews of scene 1' }).getByRole('radio', { name: '2' })).toHaveAttribute('aria-checked', 'true')
  await button.click()

  // Two Draft previews as long as the 3 s scene, tagged with the project and scene.
  const projectId = [...backend.projects.keys()][0]
  expect(backend.shotRequests).toEqual([
    { prompt: PROMPT, duration: 3, quality: 'draft', variations: 2, scene: { projectId, sceneId: expect.stringMatching(/^s-/) } },
  ])
  const status = scene.getByTestId('scene-status')
  const lines = scene.getByTestId('scene-status-text')
  await expect(lines).toHaveText(['Scene 1: preview 1 of 2, seed 1001, queued', 'Scene 1: preview 2 of 2, seed 1002, queued (1 ahead)'])

  // Real progress from the job.
  backend.runShot(0, 'running', 0.62)
  await expect(lines.first()).toHaveText('Scene 1: preview 1 of 2, seed 1001, 62%')
  await expect(status.first()).toContainText('Generating, pass 1 of 2 (step 5 of 8)…')
  await expect(status.first().getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62')
  const previews = scene.getByTestId('scene-preview')
  await expect(previews.nth(0)).toContainText('Generating 62%')

  // One finishes, one fails with ComfyUI's reason.
  backend.runShot(0, 'done')
  backend.runShot(1, 'error')
  await expect(previews.nth(0)).toContainText('Preview 1 of 2 · seed 1001Completed')
  await expect(previews.nth(1)).toContainText('Failed')
  await expect(previews.nth(1)).toContainText('ComfyUI failed in SamplerCustomAdvanced (405:344): CUDA out of memory')
  await expect(status).toHaveCount(0)

  // Use this: the chosen one is highlighted.
  await previews.nth(0).getByRole('button', { name: 'Use this' }).click()
  await expect(previews.nth(0)).toHaveAttribute('aria-current', 'true')
  await expect(previews.nth(0).getByText('Selected')).toBeVisible()

  // More previews are added to these.
  await scene.getByRole('radiogroup', { name: 'Previews of scene 1' }).getByRole('radio', { name: '1' }).click()
  await button.click()
  await expect(previews).toHaveCount(3)
  await expect(previews.nth(2)).toContainText('Preview 3 of 3 · seed 1003Queued')

  // Retry reruns only the failed preview, with its seed; the others stay as they were.
  await previews.nth(1).getByRole('button', { name: 'Retry' }).click()
  expect(backend.shotRequests[2]).toEqual({ prompt: PROMPT, duration: 3, quality: 'draft', variations: 1, seed: 1002, scene: backend.shotRequests[0].scene })
  await expect(previews.nth(1)).toContainText('Preview 2 of 3 · seed 1002Queued')
  await expect(previews.nth(0)).toContainText('Completed')
  await expect(previews.nth(0)).toHaveAttribute('aria-current', 'true')
  await expect(previews.nth(2)).toContainText('seed 1003Queued')
  await expect.poll(() => backend.shots.filter((s) => s.status === 'error')).toHaveLength(0) // the failed job was dismissed
  backend.runShot(backend.shots.findIndex((s) => s.seed === 1002), 'done')
  await expect(previews.nth(1)).toContainText('Completed')

  // The choice can change at any time.
  await previews.nth(1).getByRole('button', { name: 'Use this' }).click()
  await expect(previews.nth(1)).toHaveAttribute('aria-current', 'true')
  await expect(previews.nth(0)).not.toHaveAttribute('aria-current', 'true')

  // Everything is saved with the project: after a reload it's all still there.
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await page.reload()
  await openScenes(page)
  await expect(previews).toHaveCount(3)
  await expect(previews.nth(0)).toContainText('seed 1001Completed')
  await expect(previews.nth(1)).toContainText('seed 1002Completed')
  await expect(previews.nth(1)).toHaveAttribute('aria-current', 'true')
  await expect(previews.nth(2)).toContainText('seed 1003Queued')
  await expect(scene.getByLabel('ComfyUI prompt of scene 1')).toHaveValue(PROMPT)

  // The Media tab: scene previews aren't in the Shots list, and the library hides them unless asked.
  await page.getByRole('tab', { name: 'Media' }).click()
  await expect(page.getByTestId('shot-job')).toHaveCount(0)
  await expect(page.getByTestId('library-item')).toHaveCount(0)
  await page.getByText('Scene previews (2)').click()
  await expect(page.getByTestId('library-item')).toHaveCount(2)
})

test('a preview needs ComfyUI open, and deleting one removes its clip', async ({ page }) => {
  const backend = await fakeBackend(page, { comfy: false })
  await makeVoiceover(page)
  const panel = await openScenes(page)
  await panel.getByRole('button', { name: 'Create scenes from script' }).click()
  const scene = page.getByTestId('scene').first()
  await scene.getByLabel('ComfyUI prompt of scene 1').fill(PROMPT)
  await expect(scene.getByRole('button', { name: 'Generate previews' })).toBeDisabled()
  await expect(scene).toContainText('Open ComfyUI Desktop first')

  // Coming back to the tab checks ComfyUI again.
  backend.comfy.reachable = true
  await page.getByRole('tab', { name: 'Media' }).click()
  await openScenes(page)
  await expect(scene.getByRole('button', { name: 'Generate previews' })).toBeEnabled()
  await scene.getByRole('radiogroup', { name: 'Previews of scene 1' }).getByRole('radio', { name: '1' }).click()
  await scene.getByRole('button', { name: 'Generate previews' }).click()
  backend.runShot(0, 'done')
  const preview = scene.getByTestId('scene-preview')
  await expect(preview).toContainText('Completed')
  page.once('dialog', (dialog) => void dialog.accept())
  await preview.getByRole('button', { name: 'Delete preview 1 of 1' }).click()
  await expect(preview).toHaveCount(0)
  expect(backend.library).toHaveLength(0)
})

test('a stock scene finds Pixabay footage and puts it over exactly the scene', async ({ page }) => {
  const backend = await fakeBackend(page, {
    pixabay: [stockResult('pixabay', 11, 'Airplane window'), stockResult('pixabay', 12, 'Clouds', 'landscape')],
  })
  await makeVoiceover(page)
  const panel = await openScenes(page)
  await panel.getByRole('button', { name: 'Create scenes from script' }).click()
  const scene = page.getByTestId('scene').nth(1)
  await scene.getByRole('radio', { name: 'Stock' }).click()
  await scene.getByLabel('Stock search text of scene 2').fill('airplane window')
  await scene.getByRole('button', { name: 'Find footage' }).click()
  expect(backend.searched).toEqual([{ source: 'pixabay', query: 'airplane window', orientation: 'any' }])
  await expect(scene.getByTestId('footage-result')).toHaveCount(2)

  await scene.getByRole('button', { name: 'Use “Airplane window” for this scene' }).click()
  const clip = page.getByTestId('timeline-clip')
  await expect(clip).toHaveCount(1)
  await expect(clip).toHaveAttribute('title', 'Airplane window · 0:03.00–0:05.33')
  await expect(scene.getByTestId('scene-footage')).toHaveText('“Airplane window” is on the timeline from 0:03.00 to 0:05.33.')
  await expect(scene.getByTestId('footage-result').first()).toContainText('Using')

  // Placing it is one undo step for the clip and the scene.
  await undo(page)
  await expect(clip).toHaveCount(0)
  await expect(scene.getByTestId('scene-footage')).toHaveCount(0)
})

test('Find footage explains the missing Pixabay key', async ({ page }) => {
  await fakeBackend(page)
  await makeVoiceover(page)
  const panel = await openScenes(page)
  await panel.getByRole('button', { name: 'Create scenes from script' }).click()
  const scene = page.getByTestId('scene').first()
  await scene.getByRole('radio', { name: 'Stock' }).click()
  await scene.getByLabel('Stock search text of scene 1').fill('window')
  await expect(scene.getByRole('button', { name: 'Find footage' })).toBeDisabled()
  await expect(scene).toContainText('Find footage searches Pixabay, which needs a free API key')
})
