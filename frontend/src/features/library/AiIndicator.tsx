import { Sparkles } from 'lucide-react'
import styles from './AiIndicator.module.css'

interface AiIndicatorProps {
  /** Number of AI-generated clips on the timeline. */
  count: number
  compact?: boolean
}

/** Marks a project whose timeline contains AI-generated clips. */
export function AiIndicator({ count, compact = false }: AiIndicatorProps) {
  const clips = `${count} AI-generated ${count === 1 ? 'clip' : 'clips'}`
  return (
    <span
      className={`${styles.indicator} ${compact ? styles.compact : ''}`}
      title={`The timeline has ${clips}. YouTube asks you to disclose realistic AI-generated or altered content when you upload; the export will remind you.`}
      data-testid="ai-indicator"
    >
      <Sparkles size={compact ? 10 : 12} aria-hidden />
      {compact ? 'AI' : `Contains AI · ${count}`}
      <span className="visually-hidden">: {clips}</span>
    </span>
  )
}
