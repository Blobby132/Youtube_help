import type { RefObject } from 'react'
import { useEffect } from 'react'
import type { LibraryItem } from '../../lib/api'
import { loadFont, onFontLoaded } from '../../lib/fonts'
import { useProjectStore } from '../../state/project/store'
import type { CaptionWord } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { hasTitle, rankTop, titleShown } from '../canvas/overlayLayout'
import { type CaptionGroup, groupAt, groupCaptions } from '../captions/captionGroups'
import { useLibrary } from '../library/libraryStore'
import { rankAt } from '../ranking/rankEntries'
import { clipPlayer } from './clipPlayer'
import { drawCaption } from './drawCaptions'
import { drawClip } from './drawClip'
import { drawRank, drawTitle, measureTitle } from './drawOverlays'

/**
 * Draws the preview frame at the playhead: the clip (filled and cropped to 9:16, or fitted
 * inside over the background), the title, the ranking overlay, then captions. Redraws (at
 * most once per animation frame) when the playhead, the project, the library, a font or a
 * clip's video frame changes.
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
      const { captions, clips, canvas: settings, ranking } = useProjectStore.getState().project
      const { playhead: time, playing } = useUi.getState()
      const items = useLibrary.getState().items
      if (library?.items !== items) library = { items, byId: new Map(items.map((item) => [item.id, item])) }

      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      clipPlayer.sync(time, playing, clips, library.byId)
      const shown = clipPlayer.frame(time, clips, library.byId)
      if (shown && shown !== 'missing') drawClip(ctx, shown, settings.background)

      const { title } = settings
      const titleLayout = hasTitle(title) ? measureTitle(ctx, title) : null
      if (titleLayout) {
        void loadFont(title.fontId).catch(() => undefined)
        if (titleShown(title, time)) drawTitle(ctx, title, titleLayout)
      }
      const rank = rankAt(ranking, clips, time)
      if (rank) {
        void loadFont(ranking.style.fontId).catch(() => undefined)
        drawRank(ctx, rank.entry, rank.rank, ranking.style, rankTop(titleLayout?.bottom ?? null))
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
