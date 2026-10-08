// The project document. It is saved as-is to projects/<id>/project.json, so every
// field must be plain JSON. Times are in seconds, colors are #rrggbb.

export const PROJECT_VERSION = 1

export const CANVAS = { width: 1080, height: 1920, fps: 30 } as const

export const SCRIPT_MAX_CHARS = 5000

export type VoiceoverSource = 'ai' | 'recording' | 'upload'

export interface Voiceover {
  source: VoiceoverSource
  /** File name inside the project's media folder (always a WAV). */
  file: string
  duration: number
  /** AI read only: Kokoro voice, speed, and the script it read (to spot later edits). */
  voiceId?: string
  speed?: number
  script?: string
  /** Original file name of an upload. */
  name?: string
}

export interface MusicTrack {
  file: string
  name: string
  duration: number
}

export interface Mix {
  voiceVolume: number
  musicVolume: number
  music: MusicTrack | null
}

export type ClipFit = 'fill' | 'inside'

/**
 * A clip on the video track. Clips sit at their own start time (gaps between them stay
 * empty) and never overlap. Its media lives in the shared library (see lib/api.ts
 * LibraryItem), so the same file can be used in many projects.
 */
export interface TimelineClip {
  id: string
  /** Library item id. */
  mediaId: string
  /** Where the clip starts on the timeline. */
  start: number
  /** Length on the timeline. */
  duration: number
  /** Where playback starts inside the source media. */
  inPoint: number
  /** Playback speed: 0.5 = half speed. The clip uses duration × speed seconds of its source. */
  speed: number
  /** Which part of the picture stays when it's cropped to 9:16: 0 = left/top, 0.5 = centre, 1 = right/bottom. */
  cropX: number
  cropY: number
  /** 'fill' covers the 9:16 frame and crops (cropX/cropY); 'inside' shows the whole picture
   * with the canvas background around it. */
  fit: ClipFit
  /** Clip audio is muted unless this is on; then it plays under the voiceover at `volume`. */
  keepAudio: boolean
  volume: number
}

export interface CaptionWord {
  id: string
  text: string
  start: number
  end: number
}

export type CaptionPosition = 'top' | 'middle' | 'bottom'

export interface CaptionStyle {
  fontId: string
  fontSize: number
  color: string
  highlightColor: string
  outlineColor: string
  outlineWidth: number
  shadow: boolean
  uppercase: boolean
  position: CaptionPosition
  wordsPerCaption: 1 | 2 | 3 | 4
}

export interface Captions {
  enabled: boolean
  words: CaptionWord[]
  style: CaptionStyle
  /** The voiceover file the words were timed against; a different one means they're stale. */
  voiceoverFile: string | null
  /** 'script': your script's spelling with Whisper's timing; 'transcript': what Whisper heard. */
  source: 'script' | 'transcript' | null
}

export type BackgroundMode = 'color' | 'blur'

/** What fills the frame around a clip set to "Fit inside". */
export interface CanvasBackground {
  mode: BackgroundMode
  color: string
  /** Gaussian blur of the clip behind, in frame pixels (the CSS blur() radius, FFmpeg gblur sigma). */
  blur: number
}

export interface TitleSettings {
  enabled: boolean
  text: string
  fontId: string
  fontSize: number
  color: string
  bar: boolean
  barColor: string
  /** 'full' = whole video, 'intro' = first `seconds` seconds. */
  timing: 'full' | 'intro'
  seconds: number
}

export interface Canvas {
  background: CanvasBackground
  title: TitleSettings
}

export interface RankEntry {
  id: string
  label: string
  /** Timeline clip this entry is shown over (kept when the clip is removed, so Undo brings it back). */
  clipId: string | null
}

export interface RankStyle {
  fontId: string
  /** Height of the rank number in frame pixels; the label is about a third of it. */
  size: number
  numberColor: string
  labelColor: string
}

export interface Ranking {
  enabled: boolean
  /** 'down': the first entry is #N and the last #1; 'up': the first is #1. */
  direction: 'down' | 'up'
  /** In the order they play. */
  entries: RankEntry[]
  style: RankStyle
}

export interface Project {
  id: string
  name: string
  version: number
  createdAt?: string
  updatedAt?: string
  script: string
  voiceId: string
  /** Kokoro speaking speed, 1 = normal. */
  voiceSpeed: number
  voiceover: Voiceover | null
  mix: Mix
  clips: TimelineClip[]
  captions: Captions
  canvas: Canvas
  ranking: Ranking
}

export interface ProjectSummary {
  id: string
  name: string
  createdAt: string | null
  updatedAt: string | null
  /** Number of AI-generated clips on the saved timeline (null if the library couldn't be read). */
  aiClips?: number | null
}
