import { expect, test, type Locator, type Page } from '@playwright/test'
import { fakeBackend, LLM_BUSY, writeResult } from './fakeBackend'

// The fake voiceover is 8 s long and the fake captions time word i at i × 0.3 s, so Create scenes
// makes three scenes: 0:00.00–0:02.70, 0:02.70–0:04.80 and 0:04.80–0:08.00, a sentence each.
const SCRIPT = 'Every airplane window has a tiny hole in it. It keeps the window from fogging up. The hole lets air move between the panes.'
const COMFY_BUSY =
  "ComfyUI is generating (1 job in its queue), so the language model waits until it's done. The language model and ComfyUI share the GPU, and running both at once can run out of video memory or slow both to a crawl."

async function scenesFromScript(page: Page) {
  await page.goto('/')
  await expect(page.locator('[data-state="saved"]')).toBeVisible()
  await page.getByRole('textbox', { name: 'Script' }).fill(SCRIPT)
  await page.getByRole('button', { name: 'Generate AI read' }).click()
  await expect(page.getByText('AI read · Heart')).toBeVisible()
  await page.getByRole('button', { name: 'Generate captions' }).click()
  await expect(page.getByRole('button', { name: 'Regenerate captions' })).toBeVisible()
  await page.getByRole('tab', { name: 'Scenes' }).click()
  const panel = page.getByRole('complementary', { name: 'Script, media, scenes and ranking' })
  await panel.getByRole('button', { name: 'Create scenes from script' }).click()
  await expect(page.getByTestId('scene')).toHaveCount(3)
  return panel
}

async function expectTimes(page: Page, ranges: string[]) {
  const scenes = page.getByTestId('scene')
  await expect(scenes).toHaveCount(ranges.length)
  for (const [i, range] of ranges.entries()) {
    const [start, end] = range.split('–')
    await expect(scenes.nth(i).getByRole('textbox', { name: /^Start of scene/ })).toHaveValue(start)
    await expect(scenes.nth(i).getByRole('textbox', { name: /^End of scene/ })).toHaveValue(end)
  }
}

const source = (scene: Locator, name: 'AI' | 'Stock') => scene.getByRole('radio', { name })

test('Write scenes with AI fills in every scene, asks before replacing a field you edited, and Undo takes it back', async ({ page }) => {
  const backend = await fakeBackend(page)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Scenes' }).click()
  await expect(page.getByTestId('llm-status')).toHaveText('Language model connected · qwen/qwen3-8b · LM Studio')
  await expect(page.getByRole('button', { name: 'Write scenes with AI' })).toBeDisabled() // no scenes yet
  await expect(page.getByText('ComfyUI is asked to unload its models first, and LM Studio to unload the model afterwards.')).toBeVisible()

  const panel = await scenesFromScript(page)
  const scenes = page.getByTestId('scene')
  await scenes.nth(1).getByLabel('Visual description of scene 2').fill('A frosty window, in my words')
  await panel.getByRole('button', { name: 'Write scenes with AI' }).click()

  // Each scene went with its words (and their times) and the fields you've edited.
  await expect.poll(() => backend.llm.requests.scenes.length).toBe(1)
  const [sent] = backend.llm.requests.scenes
  expect(sent.script).toBe(SCRIPT)
  expect(sent.scenes.map((s) => s.edited)).toEqual([[], ['description'], []])
  expect(sent.scenes[1].words.map((w) => w.text).join(' ')).toBe('It keeps the window from fogging up.')
  expect(sent.scenes[1].words[0]).toEqual({ text: 'It', start: 2.7, end: 2.98 })

  // The AI has other text for your description: it asks, keeping yours unless you choose its own.
  const review = page.getByTestId('llm-review')
  await expect(review).toContainText('qwen/qwen3-8b wrote 3 scenes. Its text goes into every field you haven’t edited.')
  const question = review.getByTestId('llm-question')
  await expect(question).toHaveCount(1)
  await expect(question).toContainText('Scene 2 · Visual description')
  await expect(question.getByRole('radio', { name: 'Keep mine: A frosty window, in my words' })).toBeChecked()
  await expect(question.getByRole('radio', { name: 'Use the AI’s: AI description 2' })).not.toBeChecked()
  await review.getByRole('button', { name: 'Apply' }).click()
  await expect(review).toBeHidden()

  // Scene 1 became a stock scene with its search text; the others are AI scenes with prompts.
  await expect(source(scenes.nth(0), 'Stock')).toHaveAttribute('aria-checked', 'true')
  await expect(scenes.nth(0).getByLabel('Visual description of scene 1')).toHaveValue('AI description 1')
  await expect(scenes.nth(0).getByLabel('Stock search text of scene 1')).toHaveValue('ai search 1')
  await expect(scenes.nth(1).getByLabel('Visual description of scene 2')).toHaveValue('A frosty window, in my words')
  await expect(scenes.nth(1).getByLabel('ComfyUI prompt of scene 2')).toHaveValue('Close-up shot 2, the camera stays still. Sound: a soft hum.')
  await expect(scenes.nth(2).getByLabel('Visual description of scene 3')).toHaveValue('AI description 3')
  await expect(page.getByTestId('llm-done')).toHaveText(
    'Wrote 3 scenes with qwen/qwen3-8b, kept 1 field you edited. Undo (Ctrl+Z) brings back what was there.',
  )
  await expect(panel).toContainText('Asked ComfyUI to unload its models first. Unloaded qwen/qwen3-8b from LM Studio.')

  // Saved with the project, along with what the AI wrote (to tell your later edits apart).
  await expect
    .poll(() => [...backend.projects.values()].map((p) => (p.scenes as { aiWritten: { description?: string } }[])[2]?.aiWritten.description))
    .toEqual(['AI description 3'])

  // Run again: the AI's own text is replaced without asking, and yours is asked about again.
  await page.getByRole('button', { name: 'Write scenes with AI' }).click()
  await expect(review.getByTestId('llm-question')).toHaveCount(1)
  await review.getByRole('radio', { name: 'Use the AI’s: AI description 2' }).check()
  await review.getByRole('button', { name: 'Apply' }).click()
  await expect(scenes.nth(1).getByLabel('Visual description of scene 2')).toHaveValue('AI description 2')

  // Each run is one undo step.
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(scenes.nth(1).getByLabel('Visual description of scene 2')).toHaveValue('A frosty window, in my words')
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(source(scenes.nth(0), 'AI')).toHaveAttribute('aria-checked', 'true')
  await expect(scenes.nth(0).getByLabel('Visual description of scene 1')).toHaveValue('')
  await expect(scenes.nth(2).getByLabel('Visual description of scene 3')).toHaveValue('')
})

test('a suggested merge is made only when ticked, and the review waits if you close it', async ({ page }) => {
  const backend = await fakeBackend(page)
  backend.llm.scenes = (body) =>
    writeResult(body.scenes, {
      merges: [{ id: body.scenes[0].id, next: body.scenes[1].id, start: 0, end: 4.8, why: 'One shot of the window reads better.', replacesEdits: [] }],
      skipped: ['Scene 3 wasn’t split before “between”: the parts would be 1.2 s and 2.0 s, and scenes are 2 to 5 seconds long.'],
    })
  const panel = await scenesFromScript(page)
  await panel.getByRole('button', { name: 'Write scenes with AI' }).click()

  const review = page.getByTestId('llm-review')
  const change = review.getByTestId('llm-change')
  await expect(change).toContainText('Merge scenes 1 and 2 (0:00.00–0:04.80, 4.8 s)One shot of the window reads better.')
  await expect(change.getByRole('checkbox')).toBeChecked()
  await expect(review.getByRole('region', { name: 'Left out' })).toContainText('Scene 3 wasn’t split before “between”')

  // Closing the dialog keeps the answer: Review opens it again, with your choices.
  await change.getByText('Merge scenes 1 and 2').click()
  await expect(change.getByRole('checkbox')).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('llm-waiting')).toContainText('The language model’s scenes are waiting for your answers.')
  await expect(panel.getByRole('button', { name: 'Write scenes with AI' })).toBeDisabled()
  await page.getByTestId('llm-waiting').getByRole('button', { name: 'Review' }).click()
  await expect(change.getByRole('checkbox')).not.toBeChecked()
  await change.getByText('Merge scenes 1 and 2').click()
  await review.getByRole('button', { name: 'Apply' }).click()

  // The merged scene keeps the first one's id (and previews) and takes the AI's text for the whole stretch.
  await expectTimes(page, ['0:00.00–0:04.80', '0:04.80–0:08.00'])
  await expect(page.getByTestId('scene').first().getByLabel('Visual description of scene 1')).toHaveValue('AI description 1')
  await expect(page.getByTestId('llm-done')).toContainText('merged 1 pair of scenes')
  await page.getByRole('button', { name: 'Undo' }).click()
  await expectTimes(page, ['0:00.00–0:02.70', '0:02.70–0:04.80', '0:04.80–0:08.00'])

  // Discard changes nothing.
  await panel.getByRole('button', { name: 'Write scenes with AI' }).click()
  await review.getByRole('button', { name: 'Discard' }).click()
  await expectTimes(page, ['0:00.00–0:02.70', '0:02.70–0:04.80', '0:04.80–0:08.00'])
  await expect(page.getByTestId('scene').first().getByLabel('Visual description of scene 1')).toHaveValue('')
})

test('the language model waits while ComfyUI generates, and ComfyUI waits while it writes', async ({ page }) => {
  const backend = await fakeBackend(page)
  backend.llm.comfyBusy = COMFY_BUSY
  const panel = await scenesFromScript(page)
  const write = panel.getByRole('button', { name: 'Write scenes with AI' })
  await expect(write).toBeDisabled()
  await expect(panel.getByRole('status').filter({ hasText: 'ComfyUI is generating' })).toHaveText(COMFY_BUSY)

  // Once ComfyUI's queue is empty, checking again lets it run.
  backend.llm.comfyBusy = null
  await page.getByRole('button', { name: 'Check the language model again' }).click()
  await expect(write).toBeEnabled()

  // While it writes, scene previews (and every other ComfyUI job) wait, saying why.
  const scene = page.getByTestId('scene').nth(1)
  await scene.getByLabel('ComfyUI prompt of scene 2').fill('A frosty airplane window')
  backend.llm.hold = true
  await write.click()
  await expect(page.getByTestId('llm-progress')).toContainText('Writing scene 2 of 3…')
  await expect(scene.getByRole('button', { name: 'Generate previews' })).toBeDisabled()
  await expect(scene).toContainText(LLM_BUSY)
  await expect(scene.getByRole('button', { name: 'Rewrite the prompt of scene 2' })).toBeDisabled()
  backend.llm.release()
  await page.getByTestId('llm-review').getByRole('button', { name: 'Apply' }).click() // your prompt is kept
  await expect(scene.getByLabel('ComfyUI prompt of scene 2')).toHaveValue('A frosty airplane window')
  await expect(scene.getByRole('button', { name: 'Generate previews' })).toBeEnabled()

  // The app's own ComfyUI jobs count straight away.
  await scene.getByRole('button', { name: 'Generate previews' }).click()
  await expect(write).toBeDisabled()
  await expect(panel).toContainText("ComfyUI is generating (2 jobs in its queue), so the language model waits until it's done.")
  backend.runShot(0, 'done')
  backend.runShot(1, 'done')
  await expect(write).toBeEnabled()
})

test('an answer that couldn’t be used shows what the model wrote', async ({ page }) => {
  const backend = await fakeBackend(page)
  backend.llm.scenes = () => ({
    error: 'The language model’s answer for scenes 1 to 3 couldn’t be used, even after asking again: scene 3 is missing.',
    raw: ['{"scenes": [{"scene": 1}]}', 'Sorry, I can only describe two scenes.'],
  })
  const panel = await scenesFromScript(page)
  await panel.getByRole('button', { name: 'Write scenes with AI' }).click()
  await expect(page.getByTestId('llm-failure')).toHaveText(
    'The language model’s answer for scenes 1 to 3 couldn’t be used, even after asking again: scene 3 is missing.',
  )
  const raw = page.getByTestId('llm-raw')
  await raw.getByText('What the model wrote (2 answers)').click()
  await expect(raw.locator('pre')).toHaveText(['First answer{"scenes": [{"scene": 1}]}', 'After being asked againSorry, I can only describe two scenes.'])
  await expect(page.getByTestId('scene').first().getByLabel('Visual description of scene 1')).toHaveValue('')
})

test('Rewrite prompt asks before replacing your own prompt, and Undo brings it back', async ({ page }) => {
  const backend = await fakeBackend(page)
  await scenesFromScript(page)
  const scene = page.getByTestId('scene').nth(1)
  const prompt = scene.getByLabel('ComfyUI prompt of scene 2')
  await scene.getByLabel('Visual description of scene 2').fill('Frost on a window')
  await prompt.fill('window frost')

  const questions: string[] = []
  page.once('dialog', (dialog) => {
    questions.push(dialog.message())
    void dialog.accept()
  })
  await scene.getByRole('button', { name: 'Rewrite the prompt of scene 2' }).click()
  await expect(prompt).toHaveValue('Rewritten prompt for scene 2. Sound: wind.')
  expect(questions).toEqual(['Scene 2’s prompt has your own text. Rewrite it with the language model? Undo (Ctrl+Z) brings yours back.'])
  expect(backend.llm.requests.prompt[0].scene).toEqual({
    number: 2,
    start: 2.7,
    end: 4.8,
    narration: 'It keeps the window from fogging up.',
    description: 'Frost on a window',
    prompt: 'window frost',
    before: null,
    after: null,
  })
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(prompt).toHaveValue('window frost')

  // A failure is shown under the prompt, with what the model wrote.
  backend.llm.prompt = () => ({ error: 'The language model’s answer for scene 2’s prompt couldn’t be used, even after asking again.', raw: ['{}', '{"prompt": ""}'] })
  page.once('dialog', (dialog) => void dialog.accept())
  await scene.getByRole('button', { name: 'Rewrite the prompt of scene 2' }).click()
  await expect(scene.getByRole('alert')).toContainText('couldn’t be used, even after asking again.')
  await expect(scene.getByTestId('llm-raw')).toContainText('What the model wrote (2 answers)')
  await expect(prompt).toHaveValue('window frost')
})

test('a language model that isn’t running is explained', async ({ page }) => {
  const backend = await fakeBackend(page)
  backend.llm.reachable = false
  const panel = await scenesFromScript(page)
  await expect(page.getByTestId('llm-status')).toHaveText('Language model isn’t running')
  await expect(panel.getByRole('button', { name: 'Write scenes with AI' })).toBeDisabled()
  await expect(panel).toContainText('Start the language model server first (LM Studio or Ollama): Write with AI uses it.')
  await expect(panel).toContainText("The language model server isn't answering at http://127.0.0.1:1234/v1")
})
