import { describe, expect, it } from 'vitest'
import { looksAiGenerated } from './aiFilename'

describe('looksAiGenerated', () => {
  it.each([
    'LTX_2_5_t2v_00017_.mp4',
    'ComfyUI_00001_.png',
    'clip_00042_.MP4',
    'AnimateDiff_00003.mp4',
    'wan2.1_i2v_00012-audio.mp4',
    'hunyuan_00007.webm',
    'ComfyUI temp.mp4',
    'C:\\ComfyUI\\output\\LTX_2_5_t2v_00017_.mp4',
  ])('ticks ComfyUI output %s', (name) => {
    expect(looksAiGenerated(name)).toBe(true)
  })

  it.each([
    'holiday.mp4',
    'VID_20240101_123456.mp4',
    'IMG_00012.jpg',
    'DSC_00012_edit.mp4',
    'runway show.mp4',
    'swan_00012.mp4',
    'beach_2160p.mov',
  ])('leaves %s unticked', (name) => {
    expect(looksAiGenerated(name)).toBe(false)
  })
})
