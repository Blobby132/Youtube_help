import { useEffect, useState } from 'react'
import { api, type Voice } from '../../lib/api'
import { useUi } from '../../state/ui'

let cached: Voice[] | null = null

/** The Kokoro voice catalog from the backend, fetched once it is reachable. */
export function useVoices(): { voices: Voice[] | null; error: string | null } {
  const backend = useUi((s) => s.backend)
  const [voices, setVoices] = useState<Voice[] | null>(cached)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (cached || backend !== 'online') return
    let cancelled = false
    api
      .voices()
      .then((list) => {
        cached = list
        if (!cancelled) {
          setVoices(list)
          setError(null)
        }
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [backend])

  return { voices, error }
}
