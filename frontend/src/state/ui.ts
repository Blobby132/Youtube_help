// Editor state that is not part of the saved project.
import { create } from 'zustand'
import type { Health } from '../lib/api'

export type LeftTab = 'script' | 'media' | 'scenes' | 'ranking'
export type RightTab = 'captions' | 'canvas'
export type BackendStatus = 'connecting' | 'online' | 'offline'
export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error'

interface UiState {
  leftTab: LeftTab
  rightTab: RightTab
  backend: BackendStatus
  health: Health | null
  save: SaveStatus
  saveError: string | null
  /** Set when the startup project could not be loaded for a reason other than a missing backend. */
  loadError: string | null
  /** Playhead position in seconds. */
  playhead: number
  playing: boolean
  volume: number
  muted: boolean
  /** Timeline zoom, 0 (whole video) to 1 (close up). */
  zoom: number
  selectedClipId: string | null
  /** The scene picked on the Scenes lane or in the Scenes tab. */
  selectedSceneId: string | null
  /** The library also lists scene previews (it hides them by default). */
  showScenePreviews: boolean
  /** True when the clip settings fit beside the preview; otherwise they go in the timeline toolbar. */
  clipSettingsInPreview: boolean
}

export const useUi = create<UiState>()(() => ({
  leftTab: 'script',
  rightTab: 'captions',
  backend: 'connecting',
  health: null,
  save: 'idle',
  saveError: null,
  loadError: null,
  playhead: 0,
  playing: false,
  volume: 1,
  muted: false,
  zoom: 0.45,
  selectedClipId: null,
  selectedSceneId: null,
  showScenePreviews: false,
  clipSettingsInPreview: false,
}))

export const setUi = useUi.setState
