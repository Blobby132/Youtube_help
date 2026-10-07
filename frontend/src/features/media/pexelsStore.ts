// Pexels search state, kept outside the Media tab so results survive switching tabs.
import { create } from 'zustand'
import { api, type PexelsResult } from '../../lib/api'

export type Orientation = 'portrait' | 'any'

interface PexelsState {
  query: string
  orientation: Orientation
  results: PexelsResult[]
  page: number
  hasMore: boolean
  total: number
  status: 'idle' | 'searching' | 'more' | 'done' | 'error'
  error: string | null
}

export const usePexels = create<PexelsState>()(() => ({
  query: '',
  orientation: 'portrait',
  results: [],
  page: 0,
  hasMore: false,
  total: 0,
  status: 'idle',
  error: null,
}))

let token = 0

async function fetchPage(query: string, orientation: Orientation, page: number) {
  const mine = ++token
  usePexels.setState({ status: page === 1 ? 'searching' : 'more', error: null, query, orientation })
  try {
    const found = await api.pexelsSearch(query, page, orientation)
    if (mine !== token) return
    usePexels.setState((s) => {
      const seen = new Set(page === 1 ? [] : s.results.map((r) => r.id))
      const fresh = found.results.filter((r) => !seen.has(r.id))
      return {
        results: page === 1 ? found.results : [...s.results, ...fresh],
        page,
        hasMore: found.hasMore,
        total: found.totalResults,
        status: 'done',
      }
    })
  } catch (error) {
    if (mine !== token) return
    console.error('Pexels search failed:', error)
    usePexels.setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
  }
}

export function searchPexels(query: string, orientation: Orientation = usePexels.getState().orientation) {
  const trimmed = query.trim()
  if (!trimmed) return
  usePexels.setState({ results: [], page: 0, hasMore: false })
  return fetchPage(trimmed, orientation, 1)
}

export function loadMorePexels() {
  const { query, orientation, page, hasMore, status } = usePexels.getState()
  if (!hasMore || status === 'searching' || status === 'more') return
  return fetchPage(query, orientation, page + 1)
}

export function setOrientation(orientation: Orientation) {
  usePexels.setState({ orientation })
  const { query } = usePexels.getState()
  if (query) void searchPexels(query, orientation)
}

/** After a download: the result now points at its library item. */
export function markInLibrary(videoId: number, itemId: string) {
  usePexels.setState((s) => ({ results: s.results.map((r) => (r.id === videoId ? { ...r, libraryId: itemId } : r)) }))
}
