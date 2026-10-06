import { Check } from 'lucide-react'
import styles from './Checkbox.module.css'

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
}

/** Small accent checkbox, used for the "On" toggles next to section labels. */
export function Checkbox({ checked, onChange, label = 'On', disabled }: CheckboxProps) {
  return (
    <label className={`${styles.checkbox} ${disabled ? styles.disabled : ''}`}>
      <input
        type="checkbox"
        className="visually-hidden"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={`${styles.box} ${checked ? styles.checked : ''}`} aria-hidden>
        {checked && <Check size={10} strokeWidth={3.5} />}
      </span>
      {label}
    </label>
  )
}
