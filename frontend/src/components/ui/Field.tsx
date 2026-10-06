import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { useId } from 'react'
import styles from './Field.module.css'

interface FieldProps {
  label: string
  children: (id: string) => ReactNode
  inline?: boolean
}

/** A label above (or beside, when inline) a single control. */
export function Field({ label, children, inline = false }: FieldProps) {
  const id = useId()
  return (
    <div className={inline ? styles.inlineField : styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {children(id)}
    </div>
  )
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" className={`${styles.input} ${className ?? ''}`} {...props} />
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${styles.input} ${styles.select} ${className ?? ''}`} {...props}>
      {children}
    </select>
  )
}

interface ColorInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

export function ColorInput({ id, value, onChange, disabled }: ColorInputProps) {
  return (
    <span className={`${styles.color} ${disabled ? styles.disabled : ''}`}>
      <input
        id={id}
        type="color"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className={styles.hex}>{value.toUpperCase()}</span>
    </span>
  )
}

/** Two or more fields side by side. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className={styles.row}>{children}</div>
}
