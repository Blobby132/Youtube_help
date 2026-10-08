import { Checkbox } from '../../components/ui/Checkbox'
import { FontSelect } from '../../components/FontSelect'
import { ColorInput, Field, FieldRow, TextInput } from '../../components/ui/Field'
import { Section } from '../../components/ui/Section'
import { Segmented } from '../../components/ui/Segmented'
import { Slider } from '../../components/ui/Slider'
import { pixels } from '../../lib/format'
import { updateProject, useProject } from '../../state/project/store'
import { CANVAS, type CanvasBackground, type TitleSettings } from '../../state/project/types'
import { useLibrary } from '../library/libraryStore'
import { cropAxis } from '../preview/cover'
import styles from './CanvasPanel.module.css'

const BACKGROUND_MODES = [
  { value: 'blur', label: 'Blurred clip' },
  { value: 'color', label: 'Solid color' },
] as const

const TITLE_TIMING = [
  { value: 'full', label: 'Whole video' },
  { value: 'intro', label: 'First seconds' },
] as const

export function CanvasPanel() {
  const background = useProject((p) => p.canvas.background)
  const title = useProject((p) => p.canvas.title)
  const insideCount = useInsideClipCount()

  const setBackground = (patch: Partial<CanvasBackground>) =>
    updateProject((p) => {
      Object.assign(p.canvas.background, patch)
    })
  const setTitle = (patch: Partial<TitleSettings>) =>
    updateProject((p) => {
      Object.assign(p.canvas.title, patch)
    })

  return (
    <>
      <Section
        label="Background"
        hint={
          insideCount
            ? `Fills the frame around clips set to Fit inside (${insideCount} on the timeline).`
            : 'Fills the frame around clips set to Fit inside. Clips fill the frame unless you pick Fit inside in Clip settings.'
        }
      >
        <Segmented
          label="Background"
          options={BACKGROUND_MODES}
          value={background.mode}
          onChange={(mode) => setBackground({ mode })}
        />
        {background.mode === 'color' ? (
          <Field label="Color" inline>
            {(id) => <ColorInput id={id} value={background.color} onChange={(color) => setBackground({ color })} />}
          </Field>
        ) : (
          <Slider
            label="Blur strength"
            value={background.blur}
            min={5}
            max={100}
            step={1}
            onChange={(blur) => setBackground({ blur })}
          />
        )}
      </Section>

      <Section
        label="Title"
        hint="Optional headline at the top of the video. A ranking shows under it."
        action={<Checkbox checked={title.enabled} onChange={(enabled) => setTitle({ enabled })} />}
      >
        <fieldset className={styles.fieldset} disabled={!title.enabled}>
          <Field label="Text">
            {(id) => (
              <TextInput
                id={id}
                value={title.text}
                maxLength={120}
                placeholder="Top 5 weirdest airplane facts"
                onChange={(event) => setTitle({ text: event.target.value })}
              />
            )}
          </Field>
          <Field label="Font">
            {(id) => <FontSelect id={id} value={title.fontId} onChange={(fontId) => setTitle({ fontId })} />}
          </Field>
          <Slider
            label="Size"
            value={title.fontSize}
            min={32}
            max={140}
            step={1}
            format={pixels}
            onChange={(fontSize) => setTitle({ fontSize })}
          />
          <FieldRow>
            <Field label="Text color">
              {(id) => <ColorInput id={id} value={title.color} onChange={(color) => setTitle({ color })} />}
            </Field>
            <Field label="Bar color">
              {(id) => (
                <ColorInput
                  id={id}
                  value={title.barColor}
                  disabled={!title.bar}
                  onChange={(barColor) => setTitle({ barColor })}
                />
              )}
            </Field>
          </FieldRow>
          <Checkbox
            label="Background bar"
            checked={title.bar}
            onChange={(bar) => setTitle({ bar })}
          />
          <Field label="Show">
            {() => (
              <Segmented
                label="Show title for"
                options={TITLE_TIMING}
                value={title.timing}
                onChange={(timing) => setTitle({ timing })}
              />
            )}
          </Field>
          {title.timing === 'intro' && (
            <Slider
              label="Seconds"
              value={title.seconds}
              min={1}
              max={15}
              step={0.5}
              format={(value) => `${value}s`}
              onChange={(seconds) => setTitle({ seconds })}
            />
          )}
        </fieldset>
      </Section>
    </>
  )
}

/** Clips on the timeline that show the background: set to Fit inside and not exactly 9:16. */
function useInsideClipCount() {
  const clips = useProject((p) => p.clips)
  const items = useLibrary((s) => s.items)
  return clips.filter((clip) => {
    if (clip.fit !== 'inside') return false
    const item = items.find((i) => i.id === clip.mediaId)
    return item !== undefined && cropAxis(item.width, item.height, CANVAS.width, CANVAS.height) !== null
  }).length
}
