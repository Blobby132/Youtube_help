/** Average narration pace used for the spoken-length estimate. */
export const WORDS_PER_MINUTE = 155

export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

/** Estimated narration length in seconds. */
export function estimateSpokenSeconds(words: number): number {
  return (words / WORDS_PER_MINUTE) * 60
}
