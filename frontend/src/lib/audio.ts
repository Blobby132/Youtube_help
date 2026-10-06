// Decoding audio files into waveform peaks for drawing.
import { useEffect, useState } from 'react'

/** Peaks are stored at this resolution and resampled for drawing. */
export const PEAKS_PER_SECOND = 100

const cache = new Map<string, Promise<Float32Array>>()

async function decodePeaks(url: string): Promise<Float32Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load audio (${response.status})`)
  const context = new OfflineAudioContext(1, 1, 44_100)
  const buffer = await context.decodeAudioData(await response.arrayBuffer())
  const samples = buffer.getChannelData(0)
  const step = buffer.sampleRate / PEAKS_PER_SECOND
  const peaks = new Float32Array(Math.ceil(samples.length / step))
  let loudest = 0
  for (let i = 0; i < peaks.length; i++) {
    const end = Math.min(samples.length, Math.floor((i + 1) * step))
    let max = 0
    for (let j = Math.floor(i * step); j < end; j++) {
      const value = Math.abs(samples[j])
      if (value > max) max = value
    }
    peaks[i] = max
    if (max > loudest) loudest = max
  }
  // Normalise so quiet recordings still draw a visible waveform.
  if (loudest > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= loudest
  return peaks
}

/** Peaks for an audio URL, decoded once and cached. */
export function loadPeaks(url: string): Promise<Float32Array> {
  let pending = cache.get(url)
  if (!pending) {
    pending = decodePeaks(url)
    cache.set(url, pending)
    pending.catch(() => cache.delete(url))
  }
  return pending
}

export function usePeaks(url: string | null): Float32Array | null {
  const [result, setResult] = useState<{ url: string; peaks: Float32Array } | null>(null)
  useEffect(() => {
    if (!url) return
    let cancelled = false
    loadPeaks(url)
      .then((peaks) => !cancelled && setResult({ url, peaks }))
      .catch((error: unknown) => console.warn('Waveform unavailable:', error))
    return () => {
      cancelled = true
    }
  }, [url])
  return result && result.url === url ? result.peaks : null
}

/** Resamples peaks to `count` bars, keeping the loudest value in each bar. */
export function bucketPeaks(peaks: Float32Array, count: number): Float32Array {
  const bars = new Float32Array(Math.max(0, count))
  if (!peaks.length || count <= 0) return bars
  const step = peaks.length / count
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * step)
    const end = Math.max(start + 1, Math.floor((i + 1) * step))
    let max = 0
    for (let j = start; j < end && j < peaks.length; j++) if (peaks[j] > max) max = peaks[j]
    bars[i] = max
  }
  return bars
}
