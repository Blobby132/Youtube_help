// Fonts offered for captions and titles. All are free (SIL Open Font License);
// the same files will be used by the preview and by FFmpeg when rendering.
export interface FontOption {
  id: string
  name: string
}

export const FONTS: readonly FontOption[] = [
  { id: 'montserrat', name: 'Montserrat Black' },
  { id: 'anton', name: 'Anton' },
  { id: 'bebas-neue', name: 'Bebas Neue' },
  { id: 'poppins', name: 'Poppins ExtraBold' },
  { id: 'archivo-black', name: 'Archivo Black' },
  { id: 'bangers', name: 'Bangers' },
  { id: 'oswald', name: 'Oswald Bold' },
  { id: 'inter', name: 'Inter ExtraBold' },
]
