import type { Project } from './types'

/** Length of the video track (clips play back to back). */
export function clipsDuration(project: Project): number {
  return project.clips.reduce((total, clip) => total + clip.duration, 0)
}

/** Length of the finished video: the longer of the clips and the voiceover. */
export function projectDuration(project: Project): number {
  return Math.max(clipsDuration(project), project.voiceover?.duration ?? 0)
}

export function canRender(project: Project): boolean {
  return project.voiceover !== null && project.clips.length > 0
}
