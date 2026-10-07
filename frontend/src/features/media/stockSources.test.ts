import { describe, expect, it } from 'vitest'
import { activeSource, availableSources, formatWait } from './stockSources'

describe('stock sources', () => {
  it('lists the sources that have a key', () => {
    expect(availableSources({ pexels: false, pixabay: true })).toEqual(['pixabay'])
    expect(availableSources({ pexels: true, pixabay: false })).toEqual(['pexels'])
    expect(availableSources({ pexels: true, pixabay: true })).toEqual(['pixabay', 'pexels'])
    expect(availableSources(null)).toEqual([])
  })

  it('uses the only source with a key, or the one you picked when both have one', () => {
    expect(activeSource(['pixabay'], null)).toBe('pixabay')
    expect(activeSource(['pexels'], 'pixabay')).toBe('pexels') // picked, but no key any more
    expect(activeSource(['pixabay', 'pexels'], 'pexels')).toBe('pexels')
    expect(activeSource(['pixabay', 'pexels'], null)).toBe('pixabay')
    expect(activeSource([], null)).toBe('pixabay')
  })

  it('shows the wait for a rate limit as m:ss', () => {
    expect(formatWait(42)).toBe('0:42')
    expect(formatWait(61.2)).toBe('1:02')
    expect(formatWait(-3)).toBe('0:00')
  })
})
