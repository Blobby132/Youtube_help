import { useEffect, useRef, useState } from 'react'
import { ApiError, voicePreviewUrl } from '../../lib/api'

const samples = new Map<string, Promise<string>>()

/** Fetches (once) the sample clip for a voice as an object URL, surfacing the backend's error. */
function loadSample(voiceId: string): Promise<string> {
  let pending = samples.get(voiceId)
  if (!pending) {
    pending = fetch(voicePreviewUrl(voiceId)).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new ApiError(body?.detail ?? `Preview failed (${response.status})`, response.status)
      }
      return URL.createObjectURL(await response.blob())
    })
    samples.set(voiceId, pending)
    pending.catch(() => samples.delete(voiceId))
  }
  return pending
}

export interface VoicePreview {
  voiceId: string | null
  status: 'loading' | 'playing' | null
  error: string | null
  toggle: (voiceId: string) => void
}

/** Plays one voice sample at a time. */
export function useVoicePreview(): VoicePreview {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [voiceId, setVoiceId] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'playing' | null>(null)
  const [error, setError] = useState<string | null>(null)

  function stop() {
    audioRef.current?.pause()
    audioRef.current = null
    setVoiceId(null)
    setStatus(null)
  }

  useEffect(() => () => audioRef.current?.pause(), [])

  function toggle(id: string) {
    const same = id === voiceId
    stop()
    if (same) return
    setError(null)
    setVoiceId(id)
    setStatus('loading')
    const audio = new Audio()
    audioRef.current = audio
    audio.onplaying = () => audioRef.current === audio && setStatus('playing')
    audio.onended = () => audioRef.current === audio && stop()
    loadSample(id)
      .then((url) => {
        if (audioRef.current !== audio) return
        audio.src = url
        return audio.play()
      })
      .catch((e: unknown) => {
        if (audioRef.current !== audio) return
        stop()
        setError(e instanceof Error ? e.message : String(e))
      })
  }

  return { voiceId, status, error, toggle }
}
