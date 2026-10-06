import type { RefObject } from 'react'
import { useEffect } from 'react'
import { loadFont, onFontLoaded } from '../../lib/fonts'
import { useProjectStore } from '../../state/project/store'
import type { CaptionWord } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { type CaptionGroup, groupAt, groupCaptions } from '../captions/captionGroups'
import { drawCaption } from './drawCaptions'

/**
 * Draws the preview frame at the playhead: background, then captions. Redraws (at most once
 * per animation frame) when the playhead, the project or a font changes.
 */
export function usePreviewRenderer(canvasRef: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    let frame = 0
    let cache: { words: CaptionWord[]; perCaption: number; groups: CaptionGroup[] } | null = null

    const draw = () => {
      frame = 0
      const { captions } = useProjectStore.getState().project
      const time = useUi.getState().playhead
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

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
      useUi.subscribe((state, previous) => {
        if (state.playhead !== previous.playhead) schedule()
      }),
      onFontLoaded(schedule),
    ]
    return () => {
      cancelAnimationFrame(frame)
      unsubscribe.forEach((stop) => stop())
    }
  }, [canvasRef])
}
