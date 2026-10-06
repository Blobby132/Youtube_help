// Caption and title fonts come from the backend: the same TTF files FFmpeg renders with,
// so the preview matches the final video.
import { useEffect, useState } from 'react'
import { useUi } from '../state/ui'
import { api, fontUrl, type FontInfo } from './api'

/** CSS family a font is registered under, so it can't clash with fonts installed on the PC. */
export const fontFamily = (fontId: string) => `SC ${fontId}`

let catalog: Promise<FontInfo[]> | null = null
const faces = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

export function loadFontCatalog(): Promise<FontInfo[]> {
  catalog ??= api.fonts()
  catalog.catch(() => {
    catalog = null
  })
  return catalog
}

/** Loads a font file once; resolves when it can be drawn with. */
export function loadFont(fontId: string): Promise<void> {
  let pending = faces.get(fontId)
  if (!pending) {
    const face = new FontFace(fontFamily(fontId), `url(${fontUrl(fontId)})`)
    pending = face.load().then((loaded) => {
      document.fonts.add(loaded)
      listeners.forEach((listener) => listener())
    })
    faces.set(fontId, pending)
    pending.catch((error: unknown) => {
      faces.delete(fontId)
      console.warn(`Font ${fontId} failed to load:`, error)
    })
  }
  return pending
}

/** Calls `listener` whenever another font finishes loading (to redraw the preview). */
export function onFontLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useFontCatalog(): FontInfo[] | null {
  const backend = useUi((s) => s.backend)
  const [fonts, setFonts] = useState<FontInfo[] | null>(null)
  useEffect(() => {
    if (backend !== 'online') return
    let cancelled = false
    loadFontCatalog()
      .then((list) => {
        if (cancelled) return
        setFonts(list)
        list.forEach((font) => void loadFont(font.id))
      })
      .catch((error: unknown) => console.warn('Could not load the font list:', error))
    return () => {
      cancelled = true
    }
  }, [backend])
  return fonts
}
