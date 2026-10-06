import type { LucideIcon } from 'lucide-react'
import { LoaderCircle } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'
import styles from './Button.module.css'

type Variant = 'primary' | 'secondary' | 'ghost'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: LucideIcon
  /** Paints the icon in the accent color (secondary buttons). */
  accentIcon?: boolean
  block?: boolean
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  accentIcon = false,
  block = false,
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    styles[variant],
    styles[size],
    block && styles.block,
    !children && styles.iconOnly,
    className,
  ]
    .filter(Boolean)
    .join(' ')
  const iconSize = size === 'sm' ? 13 : 15
  return (
    <button type={type} className={classes} disabled={disabled || loading} {...rest}>
      {loading ? (
        <LoaderCircle size={iconSize} className={styles.spin} aria-hidden />
      ) : (
        Icon && <Icon size={iconSize} className={accentIcon ? styles.accentIcon : undefined} aria-hidden />
      )}
      {children}
    </button>
  )
}
