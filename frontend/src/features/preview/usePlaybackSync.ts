import { useEffect } from 'react'
import { mediaUrl } from '../../lib/api'
import { useProject } from '../../state/project/store'
import { useUi } from '../../state/ui'
import { clipPlayer } from './clipPlayer'
import { playback } from './playback'

/** Keeps the playback engine in step with the project's audio and the volume controls. */
export function usePlaybackSync() {
  const projectId = useProject((p) => p.id)
  const voiceFile = useProject((p) => p.voiceover?.file ?? null)
  const voiceDuration = useProject((p) => p.voiceover?.duration ?? 0)
  const musicFile = useProject((p) => p.mix.music?.file ?? null)
  const voiceVolume = useProject((p) => p.mix.voiceVolume)
  const musicVolume = useProject((p) => p.mix.musicVolume)
  const preview = useUi((s) => s.volume)
  const muted = useUi((s) => s.muted)

  useEffect(() => {
    playback.setSources(
      voiceFile ? mediaUrl(projectId, voiceFile) : null,
      voiceDuration,
      musicFile ? mediaUrl(projectId, musicFile) : null,
    )
  }, [projectId, voiceFile, voiceDuration, musicFile])

  useEffect(() => {
    playback.setVolumes({ preview, muted, voice: voiceVolume, music: musicVolume })
    clipPlayer.setVolume(preview, muted)
  }, [preview, muted, voiceVolume, musicVolume])

  // Switching projects stops playback.
  useEffect(
    () => () => {
      playback.pause()
      clipPlayer.reset()
    },
    [projectId],
  )

  // Space toggles play/pause unless you are typing or on a button.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, button, [contenteditable="true"], [role="slider"]')) return
      event.preventDefault()
      playback.toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
