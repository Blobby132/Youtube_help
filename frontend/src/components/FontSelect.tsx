import { Select } from './ui/Field'
import { fontFamily, useFontCatalog } from '../lib/fonts'

interface FontSelectProps {
  id?: string
  value: string
  onChange: (fontId: string) => void
}

/** Picks one of the backend's caption/title fonts; the closed box shows the font itself. */
export function FontSelect({ id, value, onChange }: FontSelectProps) {
  const fonts = useFontCatalog()
  return (
    <Select
      id={id}
      value={value}
      style={{ fontFamily: `"${fontFamily(value)}", inherit`, fontSize: 14 }}
      onChange={(event) => onChange(event.target.value)}
    >
      {(fonts ?? [{ id: value, name: value }]).map((font) => (
        <option key={font.id} value={font.id}>
          {font.name}
        </option>
      ))}
    </Select>
  )
}
