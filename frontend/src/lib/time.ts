/** 75.4 -> "1:15" */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 75.456 -> "1:15.45" (minutes, seconds, hundredths) */
export function formatTimecode(seconds: number): string {
  const hundredths = Math.max(0, Math.floor(seconds * 100 + 1e-6))
  const m = Math.floor(hundredths / 6000)
  const s = Math.floor((hundredths % 6000) / 100)
  const cs = hundredths % 100
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/**
 * A typed time in seconds, or null if it isn't one: minutes and seconds like formatTimecode
 * shows them ("0:03.04", "1:15") or plain seconds ("3.04", "75"). A comma works as the decimal
 * point and a trailing "s" is ignored.
 */
export function parseTimecode(text: string): number | null {
  const match = /^(?:(\d+):)?(\d+(?:[.,]\d*)?|[.,]\d+)\s*s?$/i.exec(text.trim())
  if (!match) return null
  const seconds = Number(match[2].replace(',', '.'))
  if (match[1] === undefined) return seconds
  return seconds < 60 ? Number(match[1]) * 60 + seconds : null
}

/** "2026-10-06T03:45:00Z" -> "5 min ago" */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const diff = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (diff < 45) return 'just now'
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)} d ago`
  return new Date(iso).toLocaleDateString()
}

/** Clip lengths: "4.2 s" for short clips, "1:05" for long ones. */
export function formatClipLength(seconds: number): string {
  if (seconds < 59.95) return `${seconds.toFixed(1)} s`
  return formatDuration(seconds)
}
