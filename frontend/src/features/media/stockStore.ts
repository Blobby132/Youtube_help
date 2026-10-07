// Stock video search state (Pexels or Pixabay), kept outside the Media tab so results
// survive switching tabs.
import { create } from 'zustand'
import { ApiError, api, type Orientation, type StockResult, type StockSource } from '../../lib/api'
import { useUi } from '../../state/ui'
import { activeSource, availableSources } from './stockSources'

const PICKED_KEY = 'shorts-creator.stockSource'

function rememberedSource(): StockSource | null {
  try {
    const value = localStorage.getItem(PICKED_KEY)
    return value === 'pexels' || value === 'pixabay' ? value : null
  } catch {
    return null
  }
}

interface StockState {
  /** The source you picked when both have a key. */
  picked: StockSource | null
  /** Source, words and orientation of the results shown. */
  source: StockSource | null
  query: string
  orientation: Orientation
  results: StockResult[]
  page: number
  hasMore: boolean
  total: number
  totalExact: boolean
  status: 'idle' | 'searching' | 'more' | 'done' | 'error'
  error: string | null
  /** While a source's rate limit is used up: when it resets (ms since epoch). */
  blockedUntil: Partial<Record<StockSource, number>>
}

export const useStock = create<StockState>()(() => ({
  picked: rememberedSource(),
  source: null,
  query: '',
  orientation: 'portrait',
  results: [],
  page: 0,
  hasMore: false,
  total: 0,
  totalExact: true,
  status: 'idle',
  error: null,
  blockedUntil: {},
}))

/** The source searches go to now. */
export function currentSource(): StockSource {
  return activeSource(availableSources(useUi.getState().health), useStock.getState().picked)
}

/** React hook version of currentSource. */
export function useCurrentSource(): StockSource {
  const health = useUi((s) => s.health)
  const picked = useStock((s) => s.picked)
  return activeSource(availableSources(health), picked)
}

let token = 0

async function fetchPage(source: StockSource, query: string, orientation: Orientation, page: number) {
  const mine = ++token
  useStock.setState({ status: page === 1 ? 'searching' : 'more', error: null, query, orientation, source })
  try {
    const found = await api.stockSearch(source, query, page, orientation)
    if (mine !== token) return
    useStock.setState((s) => {
      const seen = new Set(page === 1 ? [] : s.results.map((r) => r.id))
      return {
        results: page === 1 ? found.results : [...s.results, ...found.results.filter((r) => !seen.has(r.id))],
        page,
        hasMore: found.hasMore,
        total: found.totalResults,
        totalExact: found.totalExact ?? true,
        status: 'done',
      }
    })
  } catch (error) {
    if (mine !== token) return
    console.error(`${source} search failed:`, error)
    const retryAfter = error instanceof ApiError ? error.retryAfter : null
    useStock.setState((s) => ({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      blockedUntil: retryAfter ? { ...s.blockedUntil, [source]: Date.now() + retryAfter * 1000 } : s.blockedUntil,
    }))
  }
}

export function searchStock(query: string, orientation: Orientation = useStock.getState().orientation) {
  const trimmed = query.trim()
  if (!trimmed) return
  useStock.setState({ results: [], page: 0, hasMore: false })
  return fetchPage(currentSource(), trimmed, orientation, 1)
}

export function loadMoreStock() {
  const { source, query, orientation, page, hasMore, status } = useStock.getState()
  if (!source || !hasMore || status === 'searching' || status === 'more') return
  return fetchPage(source, query, orientation, page + 1)
}

export function setOrientation(orientation: Orientation) {
  useStock.setState({ orientation })
  const { query } = useStock.getState()
  if (query) void searchStock(query, orientation)
}

/** Switches between Pexels and Pixabay (when both have a key) and repeats the search there. */
export function pickSource(source: StockSource) {
  try {
    localStorage.setItem(PICKED_KEY, source)
  } catch {
    // Not remembered next time; that's all.
  }
  useStock.setState({ picked: source, results: [], status: 'idle', error: null })
  const { query } = useStock.getState()
  if (query) void searchStock(query)
}

/** The rate limit has reset: clear the countdown. */
export function clearBlock(source: StockSource) {
  useStock.setState((s) => {
    const blockedUntil = { ...s.blockedUntil }
    delete blockedUntil[source]
    return { blockedUntil, error: s.status === 'error' && s.source === source ? null : s.error }
  })
}

/** After a download: the result now points at its library item. */
export function markInLibrary(source: StockSource, videoId: number, itemId: string) {
  useStock.setState((s) => ({
    results: s.results.map((r) => (r.source === source && r.id === videoId ? { ...r, libraryId: itemId } : r)),
  }))
}
