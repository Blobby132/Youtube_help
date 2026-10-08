import type { LibraryItem } from '../../lib/api'
import type { Project, TimelineClip } from './types'

/** Where the last clip ends. */
export function clipsEnd(project: Project): number {
  return project.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)
}

/** Length of the finished video: the voiceover's length (clips past it are cut off). Without a
 * voiceover, the clips' length, so they can still be previewed. */
export function projectDuration(project: Project): number {
  return project.voiceover ? project.voiceover.duration : clipsEnd(project)
}

export function canRender(project: Project): boolean {
  return project.voiceover !== null && project.clips.length > 0
}

/**
 * Captions are out of date when they were timed against a voiceover other than the
 * current one, e.g. after the script changed and the AI read was regenerated.
 */
export function captionsOutOfDate(project: Project): boolean {
  const { captions, voiceover } = project
  return captions.words.length > 0 && voiceover !== null && captions.voiceoverFile !== voiceover.file
}

/**
 * Timeline clips whose library item is flagged AI-generated. The top bar shows this now; the
 * finished render's reminder asks the backend's twin, app/library/usage.py `ai_clips`.
 */
export function aiClips(clips: readonly TimelineClip[], items: readonly LibraryItem[]): TimelineClip[] {
  const ai = new Set(items.filter((item) => item.aiGenerated).map((item) => item.id))
  return clips.filter((clip) => ai.has(clip.mediaId))
}
