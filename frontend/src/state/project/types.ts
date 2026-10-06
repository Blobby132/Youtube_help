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

export type MediaKind = 'video' | 'image'

export interface MediaItem {
  id: string
  kind: MediaKind
  name: string
  source: 'pexels' | 'upload'
  file: string
  thumbnail?: string
  width: number
  height: number
  /** Seconds; images have no intrinsic duration. */
  duration?: number
  credit?: string
}

/** A clip on the video track. Clips play back to back in array order. */
export interface TimelineClip {
  id: string
  mediaId: string
  /** Where playback starts inside the source media. */
  inPoint: number
  /** Length on the timeline. */
  duration: number
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

export interface CanvasBackground {
  mode: BackgroundMode
  color: string
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
  /** Timeline clip this entry is shown over. */
  clipId: string | null
}

export interface Ranking {
  enabled: boolean
  direction: 'down' | 'up'
  entries: RankEntry[]
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
  media: MediaItem[]
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
}
