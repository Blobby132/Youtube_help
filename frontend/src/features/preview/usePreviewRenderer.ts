import type { RefObject } from 'react'
import { useEffect } from 'react'
import type { LibraryItem } from '../../lib/api'
import { loadFont, onFontLoaded } from '../../lib/fonts'
import { useProjectStore } from '../../state/project/store'
import { useUi } from '../../state/ui'
import { useLibrary } from '../library/libraryStore'
import { clipPlayer } from './clipPlayer'
import { drawClip } from './drawClip'
import { drawFrameOverlays, overlayFonts, overlayScene, type OverlayScene, overlayState } from './frameOverlays'

/**
 * Draws the preview frame at the playhead: the clip (filled and cropped to 9:16, or fitted
 * inside over the background), then the title, the ranking overlay and the caption (drawn by
 * frameOverlays.ts, which the final render uses too). Redraws (at
 * most once per animation frame) when the playhead, the project, the library, a font or a
 * clip's video frame changes.
 */
export function usePreviewRenderer(canvasRef: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    let frame = 0
    let scene: OverlayScene | null = null
    let library: { items: LibraryItem[]; byId: Map<string, LibraryItem> } | null = null

    const draw = () => {
      frame = 0
      const project = useProjectStore.getState().project
      const { clips, canvas: settings } = project
      const { playhead: time, playing } = useUi.getState()
      const items = useLibrary.getState().items
      if (library?.items !== items) library = { items, byId: new Map(items.map((item) => [item.id, item])) }

      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      clipPlayer.sync(time, playing, clips, library.byId)
      const shown = clipPlayer.frame(time, clips, library.byId)
      if (shown && shown !== 'missing') drawClip(ctx, shown, settings.background)

      scene = overlayScene(project, scene)
      for (const fontId of overlayFonts(scene)) void loadFont(fontId).catch(() => undefined)
      drawFrameOverlays(ctx, scene, overlayState(scene, time), time)
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    schedule()
    const unsubscribe = [
      useProjectStore.subscribe(schedule),
      useLibrary.subscribe((state, previous) => {
        if (state.items !== previous.items) schedule()
      }),
      useUi.subscribe((state, previous) => {
        if (state.playhead !== previous.playhead || state.playing !== previous.playing) schedule()
      }),
      onFontLoaded(schedule),
      clipPlayer.onFrame(schedule),
    ]
    return () => {
      cancelAnimationFrame(frame)
      unsubscribe.forEach((stop) => stop())
      clipPlayer.pauseAll()
    }
  }, [canvasRef])
}
