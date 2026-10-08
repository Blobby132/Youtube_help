// Draws the clip at the playhead onto the preview canvas: filled and cropped to 9:16, or
// "Fit inside" over the canvas background (a blurred copy of the clip, or a solid colour).
import type { CanvasBackground } from '../../state/project/types'
import type { ClipFrame } from './clipPlayer'
import { coverRect, insideRect } from './cover'

let blurCanvas: HTMLCanvasElement | null = null

/**
 * The clip filled to the frame and blurred by `blur` frame pixels. It's blurred at a lower
 * resolution (which blurs too, and is much cheaper), then scaled back up.
 */
function drawBlurred(ctx: CanvasRenderingContext2D, shown: ClipFrame, blur: number) {
  const { width, height } = ctx.canvas
  const factor = Math.max(1, Math.min(8, Math.floor(blur / 3)))
  blurCanvas ??= document.createElement('canvas')
  const small = blurCanvas
  const w = Math.ceil(width / factor)
  const h = Math.ceil(height / factor)
  // Resizing reallocates it: only when the blur strength changes its size.
  if (small.width !== w || small.height !== h) {
    small.width = w
    small.height = h
  }
  const sctx = small.getContext('2d')
  if (!sctx) return
  const radius = blur / factor
  // Drawn past the edges, so the blur doesn't fade into transparent at the frame's border.
  const margin = Math.ceil(radius * 2)
  const { sx, sy, sw, sh } = coverRect(shown.width, shown.height, small.width, small.height, 0.5, 0.5)
  sctx.clearRect(0, 0, w, h)
  sctx.filter = `blur(${radius}px)`
  sctx.drawImage(shown.source, sx, sy, sw, sh, -margin, -margin, small.width + margin * 2, small.height + margin * 2)
  sctx.filter = 'none'
  ctx.save()
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(small, 0, 0, small.width, small.height, 0, 0, width, height)
  ctx.restore()
}

export function drawClip(ctx: CanvasRenderingContext2D, shown: ClipFrame, background: CanvasBackground) {
  const { width, height } = ctx.canvas
  if (shown.clip.fit === 'inside') {
    if (background.mode === 'blur') {
      drawBlurred(ctx, shown, background.blur)
    } else {
      ctx.fillStyle = background.color
      ctx.fillRect(0, 0, width, height)
    }
    const rect = insideRect(shown.width, shown.height, width, height)
    ctx.drawImage(shown.source, 0, 0, shown.width, shown.height, rect.x, rect.y, rect.width, rect.height)
    return
  }
  const { sx, sy, sw, sh } = coverRect(shown.width, shown.height, width, height, shown.clip.cropX, shown.clip.cropY)
  ctx.drawImage(shown.source, sx, sy, sw, sh, 0, 0, width, height)
}
