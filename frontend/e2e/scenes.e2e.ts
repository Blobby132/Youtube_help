import { expect, test, type Locator, type Page } from '@playwright/test'
import { fakeBackend, libraryItem, stockResult } from './fakeBackend'

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

const PROMPTS = ['Airplane window at sunrise', 'A tiny hole in a window pane', 'Air moving between glass panes']

/** Fills in each scene's prompt, with one preview each. */
async function aiScenes(page: Page) {
  const scenes = page.getByTestId('scene')
  for (const [i, prompt] of PROMPTS.entries()) {
    await scenes.nth(i).getByLabel(`ComfyUI prompt of scene ${i + 1}`).fill(prompt)
    await scenes.nth(i).getByRole('radiogroup', { name: `Previews of scene ${i + 1}` }).getByRole('radio', { name: '1' }).click()
  }
  return scenes
}

test('AI scene finals: all previews, all finals with one progress panel, a failed scene retried alone, then onto the timeline', async ({ page }) => {
  const backend = await fakeBackend(page, { library: [libraryItem('m-stock', { name: 'Stock clouds' })] })
  await makeVoiceover(page)
  const panel = await openScenes(page)
  await panel.getByRole('button', { name: 'Create scenes from script' }).click()
  const scenes = await aiScenes(page)
  const allFinals = panel.getByRole('button', { name: 'Generate all finals' })
  await expect(allFinals).toBeDisabled()
  await expect(page.getByTestId('batch-note')).toHaveText('Generate all finals: Choose a preview (Use this) for scenes 1, 2 and 3 first.')

  // Generate all previews: each scene's previews, followed in one panel with a total.
  await panel.getByRole('button', { name: 'Generate all previews' }).click()
  await expect.poll(() => backend.shotRequests.map((r) => r.prompt)).toEqual(PROMPTS)
  const steps = page.getByTestId('run-step-text')
  const total = page.getByTestId('run-total')
  await expect(steps).toHaveText(['Previews: 0 of 1 done, queued', 'Previews: 0 of 1 done, queued (1 ahead)', 'Previews: 0 of 1 done, queued (2 ahead)'])
  await expect(total).toHaveText('Total 0%')
  backend.runShot(0, 'running', 0.5)
  await expect(steps.first()).toHaveText('Previews: 0 of 1 done, generating 50%')
  await expect(total).toHaveText('Total 17%')
  for (const i of [0, 1, 2]) backend.runShot(i, 'done')
  await expect(total).toHaveText('Total 100% · done')
  await expect(page.getByText('Selected')).toHaveCount(0) // it chose none of them
  await expect(panel.getByRole('button', { name: 'Generate all previews' })).toBeDisabled() // every scene has some

  // Choosing a preview in every scene makes Generate all finals available.
  for (const i of [0, 1, 2]) await scenes.nth(i).getByTestId('scene-preview').getByRole('button', { name: 'Use this' }).click()
  await allFinals.click()
  await expect.poll(() => backend.finalRequests.length).toBe(3)
  const previewIds = backend.shots.filter((s) => s.kind === 'preview').map((s) => s.itemId)
  expect(backend.finalRequests.map((r) => [r.previewItemId, r.seed])).toEqual(previewIds.map((id) => [id, undefined]))
  await expect(steps).toHaveText(['Final: queued', 'Final: queued (1 ahead)', 'Final: queued (2 ahead)'])

  // One done, one failing, one running: the failure shows its error and a Retry of its own.
  const finalOf = (n: number) => backend.shots.filter((s) => s.kind === 'final')[n].id
  const run = (id: string, change: 'running' | 'done' | 'error', progress?: number) =>
    backend.runShot(backend.shots.findIndex((s) => s.id === id), change, progress)
  const [first, second, third] = [finalOf(0), finalOf(1), finalOf(2)]
  run(first, 'done')
  run(second, 'error')
  run(third, 'running', 0.4)
  await expect(steps).toHaveText(['Final: done', 'Final: failed', 'Final: generating 40%'])
  await expect(total).toHaveText('Total 47%')
  const failed = page.getByTestId('run-step').nth(1)
  await expect(failed).toContainText('ComfyUI failed in SamplerCustomAdvanced (405:344): CUDA out of memory')
  await expect(scenes.nth(1).getByTestId('scene-final-row')).toContainText('Failed')
  await failed.getByRole('button', { name: 'Retry scene 2' }).click()
  await expect.poll(() => backend.finalRequests.length).toBe(4)
  expect(backend.finalRequests[3]).toEqual({ ...backend.finalRequests[1], seed: 42 }) // same preview, same refine seed
  await expect(steps).toHaveText(['Final: done', 'Final: queued (1 ahead)', 'Final: generating 40%']) // behind the one running
  run(third, 'done')
  run(backend.shots[backend.shots.length - 1].id, 'done')
  await expect(total).toHaveText('Total 100% · done')
  await expect(scenes.nth(0).getByTestId('scene-final-row')).toContainText('Final from preview 1')
  await expect(scenes.nth(0).getByTestId('scene-final-row')).toContainText('Completed')

  // A stock clip already covers part of scene 1 (0 to 2 s).
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByRole('button', { name: 'Add “Stock clouds” to the timeline' }).click()
  await openScenes(page)
  const clips = page.getByTestId('timeline-clip')
  await expect(clips).toHaveCount(1)

  // Add all asks first; "only the empty scenes" leaves scene 1 as it is. One undo step.
  await panel.getByRole('button', { name: 'Add all to timeline' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add all finals to the timeline' })
  await expect(dialog).toContainText('This scene already has clips in its time:Scene 1 (0:00.00–0:03.00)')
  await dialog.getByRole('button', { name: 'Only the 2 empty scenes' }).click()
  const titles = ['Stock clouds · 0:00.00–0:02.00', `Final: ${PROMPTS[1]} · 0:03.00–0:05.33`, `Final: ${PROMPTS[2]} · 0:05.33–0:08.00`]
  await expect(clips).toHaveCount(3)
  for (const [i, title] of titles.entries()) await expect(clips.nth(i)).toHaveAttribute('title', title)
  await expect(scenes.nth(1).getByTestId('scene-final-row')).toContainText('On the timeline') // so it isn't added twice

  // Scene 1's own Add to timeline asks before replacing the stock clip.
  const questions: string[] = []
  page.once('dialog', (question) => {
    questions.push(question.message())
    void question.accept()
  })
  await scenes.nth(0).getByRole('button', { name: 'Add to timeline' }).click()
  expect(questions).toEqual(['Scene 1 already has clips between 0:00.00 and 0:03.00. Replace them with its final? Undo (Ctrl+Z) brings them back.'])
  await expect(clips.nth(0)).toHaveAttribute('title', `Final: ${PROMPTS[0]} · 0:00.00–0:03.00`)
  await expect(clips).toHaveCount(3)
  await expect(panel.getByRole('button', { name: 'Add all to timeline' })).toBeDisabled() // every final is there

  // Undo brings the stock clip back; Undo again takes both finals out at once.
  await undo(page)
  for (const [i, title] of titles.entries()) await expect(clips.nth(i)).toHaveAttribute('title', title)
  await undo(page)
  await expect(clips).toHaveCount(1)
  await expect(clips.first()).toHaveAttribute('title', titles[0])

  // Regenerate final: scene 3's final again from the same preview, with a new refine seed.
  await scenes.nth(2).getByRole('button', { name: 'Regenerate final' }).click()
  await expect.poll(() => backend.finalRequests.length).toBe(5)
  expect(backend.finalRequests[4]).toMatchObject({ previewItemId: previewIds[2], scene: backend.finalRequests[2].scene })
  expect(backend.finalRequests[4].seed).toEqual(expect.any(Number))
  expect(backend.finalRequests[4].seed).not.toBe(42)
  await expect(steps).toHaveText(['Final: queued'])

  // All of it is saved with the project.
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await page.reload()
  await openScenes(page)
  await expect(scenes.nth(0).getByTestId('scene-final-row')).toContainText('Completed')
  await expect(scenes.nth(2).getByTestId('scene-final-row')).toContainText('Queued')
  await expect(steps).toHaveText(['Final: queued'])
})

test('a preview made before finals could match says so, and offers no final', async ({ page }) => {
  const backend = await fakeBackend(page, { previewLatents: false })
  await makeVoiceover(page)
  const panel = await openScenes(page)
  await panel.getByRole('button', { name: 'Create scenes from script' }).click()
  const scene = page.getByTestId('scene').first()
  await scene.getByLabel('ComfyUI prompt of scene 1').fill(PROMPT)
  await scene.getByRole('radiogroup', { name: 'Previews of scene 1' }).getByRole('radio', { name: '1' }).click()
  await scene.getByRole('button', { name: 'Generate previews' }).click()
  backend.runShot(0, 'done')
  const preview = scene.getByTestId('scene-preview')
  await expect(preview).toContainText('Completed')
  await expect(preview.getByTestId('old-preview')).toHaveText('Made before finals could match previews: a final made from it would be a different video.')
  const final = scene.getByTestId('scene-final')
  await expect(final.getByRole('button', { name: 'Generate final' })).toBeDisabled()
  await expect(final).toContainText('Choose a preview first (Use this): the final is made from it.')

  await preview.getByRole('button', { name: 'Use this' }).click()
  await expect(final.getByTestId('final-mismatch')).toHaveText(
    'This preview was made before finals could match their previews, so a final made from it would be a different video. Generate new previews and use one of those.',
  )
  await expect(final.getByRole('button', { name: 'Generate final' })).toBeDisabled()
  expect(backend.finalRequests).toEqual([])
})
