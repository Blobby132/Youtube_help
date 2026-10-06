const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Short random id like `p-k3x9q2m7ab`; safe for file and folder names. */
export function newId(prefix: string, length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let id = ''
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length]
  return `${prefix}-${id}`
}
