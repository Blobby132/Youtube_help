// The project document. It is saved as-is to projects/<id>/project.json, so every
// field must be plain JSON. Times are in seconds, colors are #rrggbb.

export const PROJECT_VERSION = 2

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

/** A stretch of the video, in seconds. */
export interface TimeRange {
  start: number
  end: number
}

export interface RankEntry {
  id: string
  label: string
  /** When the entry is on screen, on its own (clip edits never change it). Entries never
   * overlap. null until it's given a time. Projects before version 2 linked a clip instead. */
  time: TimeRange | null
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

/** Where a scene's picture comes from: an AI clip made by ComfyUI, stock footage, or nothing yet. */
export type SceneSource = 'ai' | 'stock' | 'none'

/**
 * A stretch of the video with one picture (the Scenes tab). Scenes never overlap and are
 * listed in time order, so a scene's number is its position. Its narration is the words in
 * its time range (from the captions, or estimated from the script), so it isn't stored.
 */
export interface Scene {
  id: string
  start: number
  end: number
  source: SceneSource
  /** What should be on screen, in plain words. */
  description: string
  /** The text-to-video prompt for ComfyUI (AI scenes). */
  prompt: string
  /** The words "Find footage" searches Pixabay for (stock scenes). */
  searchText: string
  /** AI scenes: how many previews "Generate previews" makes at once (1 to 4). */
  previewCount: number
  /** AI scenes: the preview picked with "Use this" (an id in Project.scenePreviews). */
  selectedPreviewId: string | null
  /** Stock scenes: the library item placed on the timeline from "Find footage". */
  stockItemId: string | null
}

/** Where a preview's ComfyUI job is: the same states as a Generate shot job. */
export type PreviewStatus = 'queued' | 'running' | 'saving' | 'done' | 'error' | 'cancelled'

/**
 * A Draft preview of an AI scene, made by the Generate shot jobs (backend
 * data/generations.json). Its video is a library clip; this is the project's own record of
 * it (seed, last known job state), so it outlives the job list. Previews are kept apart from
 * the scenes: undoing a scene edit never removes one, only deleting it does.
 */
export interface ScenePreview {
  id: string
  sceneId: string
  /** The Generate shot job making it; a retry gets a new job with the same seed. */
  jobId: string
  seed: number
  prompt: string
  /** Seconds, a whole number from 2 to 5. */
  duration: number
  status: PreviewStatus
  /** ComfyUI's reason when it failed. */
  error: string | null
  /** The library clip once it's made. */
  itemId: string | null
  createdAt: string
}

/**
 * The final of an AI scene, made from its chosen preview: the preview's own first pass, upscaled
 * and refined (the backend's Generate final), so it shows the same shot. Like previews, the
 * project keeps its own record of each one (not on the undo history), and its video is a library
 * clip. A scene's final is its newest one; Regenerate final adds another.
 */
export interface SceneFinal {
  id: string
  sceneId: string
  /** The preview it's made from (an id in scenePreviews) and that preview's library clip. */
  previewId: string
  previewItemId: string
  /** The job making it; a retry gets a new job with the same preview and refine seed. */
  jobId: string
  /** The refine pass's seed (the workflow's own for a first final, a new one for Regenerate). */
  refineSeed: number | null
  status: PreviewStatus
  error: string | null
  itemId: string | null
  createdAt: string
}

/** One scene's part of a generation run: its previews, or its final. */
export interface RunStep {
  sceneId: string
  kind: 'previews' | 'final'
  /** What it made: preview ids, or the final's id. Empty until it's queued, or when it couldn't be. */
  recordIds: string[]
  /** Why it couldn't be queued (no prompt, ComfyUI closed, …); a Retry tries again. */
  error: string | null
}

/**
 * What the Scenes tab's progress panel shows: the previews and finals asked for together
 * ("Generate all previews", "Generate all finals", or one scene's while those run), until a new
 * run starts after it has finished.
 */
export interface GenerationRun {
  id: string
  steps: RunStep[]
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
  /** In time order. */
  scenes: Scene[]
  scenePreviews: ScenePreview[]
  sceneFinals: SceneFinal[]
  generationRun: GenerationRun | null
}

export interface ProjectSummary {
  id: string
  name: string
  createdAt: string | null
  updatedAt: string | null
  /** Number of AI-generated clips on the saved timeline (null if the library couldn't be read). */
  aiClips?: number | null
}
