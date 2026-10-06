import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { bucketPeaks } from '../../lib/audio'
import styles from './Waveform.module.css'

interface WaveformProps {
  peaks: Float32Array | null
  /** 0..1, the part drawn in the "played" color. */
  progress?: number
  /** Width of one bar plus its gap, in CSS pixels. */
  barSpacing?: number
  onSeek?: (fraction: number) => void
  className?: string
  label?: string
}

const MAX_CANVAS_PX = 16_384

/** Bar waveform on a canvas; resizes with its container. */
export function Waveform({ peaks, progress = 0, barSpacing = 3, onSeek, className, label }: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width || !size.height) return
    const scale = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_PX / size.width)
    canvas.width = Math.round(size.width * scale)
    canvas.height = Math.round(size.height * scale)
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(scale, 0, 0, scale, 0, 0)
    context.clearRect(0, 0, size.width, size.height)
    const styles = getComputedStyle(canvas)
    const played = styles.getPropertyValue('--wave-played').trim() || '#ff3d6e'
    const rest = styles.getPropertyValue('--wave-color').trim() || '#55555f'
    const count = Math.floor(size.width / barSpacing)
    const bars = peaks ? bucketPeaks(peaks, count) : new Float32Array(count)
    const barWidth = Math.max(1, barSpacing - 1)
    const middle = size.height / 2
    const playedUntil = progress * size.width
    for (let i = 0; i < count; i++) {
      const x = i * barSpacing
      const height = Math.max(1.5, bars[i] * (size.height - 2))
      context.fillStyle = x < playedUntil ? played : rest
      context.fillRect(x, middle - height / 2, barWidth, height)
    }
  }, [peaks, progress, size, barSpacing])

  function seek(event: ReactPointerEvent<HTMLDivElement>) {
    if (!onSeek || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    onSeek(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)))
  }

  return (
    <div
      ref={containerRef}
      className={`${styles.waveform} ${onSeek ? styles.seekable : ''} ${className ?? ''}`}
      onPointerDown={seek}
      role={onSeek ? 'slider' : 'img'}
      aria-label={label ?? 'Waveform'}
      aria-valuenow={onSeek ? Math.round(progress * 100) : undefined}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? 100 : undefined}
    >
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  )
}
