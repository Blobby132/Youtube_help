import { newId } from '../../lib/ids'
import { PROJECT_VERSION, type Project, type TimelineClip } from './types'

export const DEFAULT_VOICE_ID = 'af_heart'

export function createProject(name = 'Untitled short'): Project {
  return {
    id: newId('p'),
    name,
    version: PROJECT_VERSION,
    script: '',
    voiceId: DEFAULT_VOICE_ID,
    voiceSpeed: 1,
    voiceover: null,
    mix: { voiceVolume: 1, musicVolume: 0.15, music: null },
    clips: [],
    captions: {
      enabled: true,
      words: [],
      voiceoverFile: null,
      source: null,
      // Bold, centered, one word at a time: the classic Shorts look.
      style: {
        fontId: 'montserrat',
        fontSize: 96,
        color: '#ffffff',
        highlightColor: '#ffd60a',
        outlineColor: '#000000',
        outlineWidth: 8,
        shadow: true,
        uppercase: false,
        position: 'middle',
        wordsPerCaption: 1,
      },
    },
    canvas: {
      background: { mode: 'blur', color: '#000000', blur: 40 },
      title: {
        enabled: false,
        text: '',
        fontId: 'montserrat',
        fontSize: 72,
        color: '#ffffff',
        bar: true,
        barColor: '#000000',
        timing: 'full',
        seconds: 3,
      },
    },
    ranking: { enabled: true, direction: 'down', entries: [] },
  }
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Fills fields missing from `value` with the ones from `defaults`, recursively. */
function withDefaults<T>(defaults: T, value: unknown): T {
  if (!isObject(defaults) || !isObject(value)) {
    return (value === undefined ? defaults : value) as T
  }
  const merged: Json = { ...defaults }
  for (const [key, item] of Object.entries(value)) {
    merged[key] = key in defaults ? withDefaults((defaults as Json)[key], item) : item
  }
  return merged as T
}

/** Settings a clip gets when it's added: centred crop, muted, normal speed. */
export const CLIP_DEFAULTS = {
  inPoint: 0,
  speed: 1,
  cropX: 0.5,
  cropY: 0.5,
  keepAudio: false,
  volume: 0.5,
} as const satisfies Partial<TimelineClip>

function normalizeClip(raw: unknown): TimelineClip | null {
  if (!isObject(raw) || typeof raw.mediaId !== 'string') return null
  const clip = withDefaults({ id: newId('c'), start: 0, duration: 1, ...CLIP_DEFAULTS } as TimelineClip, raw)
  return clip.duration > 0 && clip.speed > 0 ? clip : null
}

/** Upgrades a project loaded from disk (possibly saved by an older build). */
export function normalizeProject(raw: unknown): Project {
  if (!isObject(raw) || typeof raw.id !== 'string') {
    throw new Error('This file is not a Shorts Creator project')
  }
  const base = createProject()
  const project = withDefaults({ ...base, id: raw.id }, raw)
  // Stage 1-3 projects had a per-project media list; media now lives in the shared library.
  delete (project as Project & { media?: unknown }).media
  project.clips = (Array.isArray(raw.clips) ? raw.clips : [])
    .map(normalizeClip)
    .filter((clip): clip is TimelineClip => clip !== null)
    .sort((a, b) => a.start - b.start)
  return project
}
