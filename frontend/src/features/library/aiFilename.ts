// Guesses whether an imported file is a ComfyUI output, to pre-tick "AI-generated".
//
// ComfyUI's save nodes name files <prefix>_<5-digit counter>_.<ext>, e.g.
// LTX_2_5_t2v_00017_.mp4 or ComfyUI_00001_.png. Video Helper Suite's "Video Combine" drops the
// trailing underscore (AnimateDiff_00003.mp4, wan_00012-audio.mp4), so without it the name must
// also mention a video model or ComfyUI.
const COUNTER = /_\d{5}_\.[a-z0-9]+$/i
const LOOSE_COUNTER = /_\d{5}(?:[-_]audio)?\.[a-z0-9]+$/i
const COMFY_PREFIX = /^comfy(?:ui)?[\s_-]/i
const MODEL_WORDS =
  /(?:^|[^a-z0-9])(?:ltxv?|wan(?:2[._]?\d?)?|hunyuan(?:video)?|animatediff|cogvideox?|mochi|svd(?:_xt)?|t2v|i2v|v2v|comfy(?:ui)?)(?=[^a-z]|$)/i

export function looksAiGenerated(fileName: string): boolean {
  const name = fileName.split(/[\\/]/).pop() ?? fileName
  if (COUNTER.test(name) || COMFY_PREFIX.test(name)) return true
  return LOOSE_COUNTER.test(name) && MODEL_WORDS.test(name.replace(LOOSE_COUNTER, ''))
}
