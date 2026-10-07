import type { RefObject } from 'react'
import { useEffect } from 'react'
import type { LibraryItem } from '../../lib/api'
import { loadFont, onFontLoaded } from '../../lib/fonts'
import { useProjectStore } from '../../state/project/store'
import type { CaptionWord } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { type CaptionGroup, groupAt, groupCaptions } from '../captions/captionGroups'
import { useLibrary } from '../library/libraryStore'
import { clipPlayer } from './clipPlayer'
import { coverRect } from './cover'
import { drawCaption } from './drawCaptions'

/**
 * Draws the preview frame at the playhead: the clip (filled to 9:16 and cropped), then
 * captions. Redraws (at most once per animation frame) when the playhead, the project, the
 * library, a font or a clip's video frame changes.
 */
export function usePreviewRenderer(canvasRef: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    let frame = 0
    let cache: { words: CaptionWord[]; perCaption: number; groups: CaptionGroup[] } | null = null
    let library: { items: LibraryItem[]; byId: Map<string, LibraryItem> } | null = null

    const draw = () => {
      frame = 0
      const { captions, clips } = useProjectStore.getState().project
      const { playhead: time, playing } = useUi.getState()
      const items = useLibrary.getState().items
      if (library?.items !== items) library = { items, byId: new Map(items.map((item) => [item.id, item])) }

      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      clipPlayer.sync(time, playing, clips, library.byId)
      const shown = clipPlayer.frame(time, clips, library.byId)
      if (shown && shown !== 'missing') {
        const { sx, sy, sw, sh } = coverRect(shown.width, shown.height, canvas.width, canvas.height, shown.clip.cropX, shown.clip.cropY)
        ctx.drawImage(shown.source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
      }

      if (captions.enabled && captions.words.length) {
        const perCaption = captions.style.wordsPerCaption
        if (!cache || cache.words !== captions.words || cache.perCaption !== perCaption) {
          cache = { words: captions.words, perCaption, groups: groupCaptions(captions.words, perCaption) }
        }
        void loadFont(captions.style.fontId).catch(() => undefined)
        const group = groupAt(cache.groups, time)
        if (group) drawCaption(ctx, group, time, captions.style)
      }
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
