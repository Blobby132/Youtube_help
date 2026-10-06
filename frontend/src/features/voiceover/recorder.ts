// Microphone recording with MediaRecorder. State lives here (not in a component) so a
// recording keeps going if you switch tabs.
import { create } from 'zustand'
import { playback } from '../preview/playback'
import { importVoiceover } from './voiceoverTasks'

const MAX_SECONDS = 10 * 60
const MIME_TYPES: [string, string][] = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/webm', 'webm'],
  ['audio/ogg;codecs=opus', 'ogg'],
  ['audio/mp4', 'mp4'],
]

interface RecorderState {
  status: 'idle' | 'requesting' | 'recording'
  startedAt: number
  /** Input level 0..1 for the meter. */
  level: number
  error: string | null
}

export const useRecorder = create<RecorderState>()(() => ({ status: 'idle', startedAt: 0, level: 0, error: null }))

let session: {
  recorder: MediaRecorder
  stream: MediaStream
  context: AudioContext
  chunks: Blob[]
  extension: string
  keep: boolean
  frame: number
  timeout: ReturnType<typeof setTimeout>
} | null = null

function describe(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Microphone access was blocked. Allow it in the browser (the icon left of the address bar), then try again.'
    }
    if (error.name === 'NotFoundError') return 'No microphone was found. Plug one in and try again.'
    if (error.name === 'NotReadableError') return 'The microphone is busy in another app. Close that app and try again.'
  }
  return error instanceof Error ? error.message : String(error)
}

export async function startRecording() {
  if (useRecorder.getState().status !== 'idle') return
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    useRecorder.setState({ error: 'This browser cannot record audio. Use Chrome, Edge or Firefox.' })
    return
  }
  // Don't record the preview playing through the speakers.
  playback.pause()
  useRecorder.setState({ status: 'requesting', error: null })
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    })
    const [mimeType, extension] = MIME_TYPES.find(([type]) => MediaRecorder.isTypeSupported(type)) ?? ['', 'webm']
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    context.createMediaStreamSource(stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)

    const current = {
      recorder,
      stream,
      context,
      chunks: [] as Blob[],
      extension,
      keep: false,
      frame: 0,
      timeout: setTimeout(() => stopRecording(true), MAX_SECONDS * 1000),
    }
    session = current

    const meter = () => {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += sample * sample
      useRecorder.setState({ level: Math.min(1, Math.sqrt(sum / samples.length) * 4) })
      current.frame = requestAnimationFrame(meter)
    }

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) current.chunks.push(event.data)
    }
    recorder.onstop = () => {
      cancelAnimationFrame(current.frame)
      clearTimeout(current.timeout)
      stream.getTracks().forEach((track) => track.stop())
      void context.close()
      session = null
      useRecorder.setState({ status: 'idle', level: 0 })
      if (current.keep && current.chunks.length) {
        const blob = new Blob(current.chunks, { type: recorder.mimeType || 'audio/webm' })
        void importVoiceover(blob, `recording.${current.extension}`, 'recording')
      }
    }

    recorder.start(250)
    meter()
    useRecorder.setState({ status: 'recording', startedAt: Date.now() })
  } catch (error) {
    console.error('Recording failed to start:', error)
    useRecorder.setState({ status: 'idle', error: describe(error) })
  }
}

/** Stops recording; `keep` uploads the take as the voiceover, otherwise it is discarded. */
export function stopRecording(keep: boolean) {
  if (!session) return
  session.keep = keep
  if (session.recorder.state !== 'inactive') session.recorder.stop()
}
