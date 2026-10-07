// Which stock video source the Media tab searches: the one with an API key, or (with both)
// the one you picked.
import type { Health, StockSource } from '../../lib/api'

export const SOURCE_LABEL: Record<StockSource, string> = { pexels: 'Pexels', pixabay: 'Pixabay' }
export const SOURCE_SITE: Record<StockSource, string> = {
  pexels: 'https://www.pexels.com',
  pixabay: 'https://pixabay.com',
}

/** Sources with a key in .env. */
export function availableSources(health: Pick<Health, 'pexels' | 'pixabay'> | null): StockSource[] {
  if (!health) return []
  return (['pixabay', 'pexels'] as const).filter((source) => health[source])
}

/**
 * The source to search: the one you picked if it has a key, else the only (or first) one with
 * a key. Without any key, Pixabay, so a search explains how to add its key.
 */
export function activeSource(available: readonly StockSource[], picked: StockSource | null): StockSource {
  if (picked && available.includes(picked)) return picked
  return available[0] ?? 'pixabay'
}

/** "0:42" until a rate limit resets. */
export function formatWait(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
