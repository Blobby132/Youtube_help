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
