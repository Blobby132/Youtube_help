import { Checkbox } from '../../components/ui/Checkbox'
import { FontSelect } from '../../components/FontSelect'
import { ColorInput, Field, FieldRow } from '../../components/ui/Field'
import { Segmented } from '../../components/ui/Segmented'
import { Slider } from '../../components/ui/Slider'
import { pixels } from '../../lib/format'
import { updateProject, useProject } from '../../state/project/store'
import type { CaptionStyle } from '../../state/project/types'
import styles from './CaptionStyleControls.module.css'

const POSITIONS = [
  { value: 'top', label: 'Top' },
  { value: 'middle', label: 'Middle' },
  { value: 'bottom', label: 'Bottom' },
] as const

const WORDS_PER_CAPTION = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
] as const

export function CaptionStyleControls() {
  const style = useProject((p) => p.captions.style)
  const set = (patch: Partial<CaptionStyle>) =>
    updateProject((p) => {
      Object.assign(p.captions.style, patch)
    })

  return (
    <>
      <Field label="Font">
        {(id) => <FontSelect id={id} value={style.fontId} onChange={(fontId) => set({ fontId })} />}
      </Field>
      <Slider
        label="Size"
        value={style.fontSize}
        min={40}
        max={160}
        step={1}
        format={pixels}
        onChange={(fontSize) => set({ fontSize })}
      />
      <Field label="Words per caption">
        {() => (
          <Segmented
            label="Words per caption"
            options={WORDS_PER_CAPTION}
            value={style.wordsPerCaption}
            onChange={(wordsPerCaption) => set({ wordsPerCaption })}
          />
        )}
      </Field>
      <Field label="Position">
        {() => (
          <Segmented
            label="Position"
            options={POSITIONS}
            value={style.position}
            onChange={(position) => set({ position })}
          />
        )}
      </Field>
      <FieldRow>
        <Field label="Text">
          {(id) => <ColorInput id={id} value={style.color} onChange={(color) => set({ color })} />}
        </Field>
        <Field label="Spoken word">
          {(id) => (
            <ColorInput id={id} value={style.highlightColor} onChange={(highlightColor) => set({ highlightColor })} />
          )}
        </Field>
      </FieldRow>
      {style.wordsPerCaption === 1 && (
        <p className={styles.hint}>The spoken-word color shows with 2 or more words per caption.</p>
      )}
      <FieldRow>
        <Field label="Outline">
          {(id) => (
            <ColorInput id={id} value={style.outlineColor} onChange={(outlineColor) => set({ outlineColor })} />
          )}
        </Field>
        <Slider
          label="Width"
          value={style.outlineWidth}
          min={0}
          max={20}
          step={1}
          format={pixels}
          onChange={(outlineWidth) => set({ outlineWidth })}
        />
      </FieldRow>
      <div className={styles.toggles}>
        <Checkbox label="Drop shadow" checked={style.shadow} onChange={(shadow) => set({ shadow })} />
        <Checkbox label="UPPERCASE" checked={style.uppercase} onChange={(uppercase) => set({ uppercase })} />
      </div>
    </>
  )
}
