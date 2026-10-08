// Stock scenes: "Find footage" searches Pixabay for the scene's search text, and the result you
// choose is downloaded into the library (like Add in the Media tab) and placed on the timeline
// over exactly the scene's time. Placing it is one undo step for the clips and the scene.
import { create } from 'zustand'
import { ApiError, api, type LibraryItem, type StockResult } from '../../lib/api'
import { newId } from '../../lib/ids'
import { useProjectStore } from '../../state/project/store'
import { setUi } from '../../state/ui'
import { addFromStock, useLibrary } from '../library/libraryStore'
import { markInLibrary, useStock } from '../media/stockStore'
import { placeClip } from '../timeline/clipOps'
import { editTimeline } from '../timeline/timelineEdits'

export interface SceneSearch {
  query: string
  status: 'searching' | 'done' | 'error'
  results: StockResult[]
  error: string | null
}

interface SceneStockState {
  /** The last search of each scene, by scene id (kept while you switch tabs). */
  searches: Record<string, SceneSearch>
  /** Why placing a scene's footage failed, by scene id. */
  failures: Record<string, string>
}

export const useSceneStock = create<SceneStockState>()(() => ({ searches: {}, failures: {} }))

function setSearch(sceneId: string, search: SceneSearch | null) {
  useSceneStock.setState((s) => {
    const searches = { ...s.searches }
    if (search) searches[sceneId] = search
    else delete searches[sceneId]
    return { searches }
  })
}

function setFailure(sceneId: string, failure: string | null) {
  useSceneStock.setState((s) => {
    const failures = { ...s.failures }
    if (failure) failures[sceneId] = failure
    else delete failures[sceneId]
    return { failures }
  })
}

export const closeSearch = (sceneId: string) => setSearch(sceneId, null)

/** "Find footage": Pixabay videos for the scene's search text, portrait ones first. */
export async function findFootage(sceneId: string): Promise<void> {
  const scene = useProjectStore.getState().project.scenes.find((s) => s.id === sceneId)
  const query = scene?.searchText.trim()
  if (!query) return
  setFailure(sceneId, null)
  setSearch(sceneId, { query, status: 'searching', results: [], error: null })
  try {
    const found = await api.stockSearch('pixabay', query, 1, 'any')
    setSearch(sceneId, { query, status: 'done', results: found.results, error: null })
  } catch (error) {
    const retryAfter = error instanceof ApiError ? error.retryAfter : null
    // Shared with the Media tab, so both wait out Pixabay's rate limit.
    if (retryAfter) useStock.setState((s) => ({ blockedUntil: { ...s.blockedUntil, pixabay: Date.now() + retryAfter * 1000 } }))
    setSearch(sceneId, { query, status: 'error', results: [], error: error instanceof Error ? error.message : String(error) })
  }
}

/** Puts a library clip on the timeline over the scene's time, in place of what's there. */
export function placeFootage(sceneId: string, item: LibraryItem): boolean {
  const id = newId('c')
  const placed = editTimeline(({ clips, scenes }) => {
    const scene = scenes.find((s) => s.id === sceneId)
    if (!scene) return null
    const media = { id: item.id, duration: item.kind === 'image' ? null : item.duration }
    return {
      clips: placeClip(clips, media, scene.start, scene.end, id, newId('c')),
      scenes: scenes.map((s) => (s.id === sceneId ? { ...s, stockItemId: item.id } : s)),
    }
  })
  if (placed) setUi({ selectedClipId: id })
  return placed
}

/** "Use" on a result: downloads it into the library if needed, then places it for the scene. */
export async function chooseFootage(sceneId: string, result: StockResult): Promise<void> {
  setFailure(sceneId, null)
  const known = result.libraryId ? useLibrary.getState().items.find((i) => i.id === result.libraryId) : undefined
  const item = known ?? (await addFromStock('pixabay', result.id))
  if (!item) {
    const reason = useLibrary.getState().downloads[`pixabay:${result.id}`]?.error
    setFailure(sceneId, `Could not download “${result.title}”${reason ? `: ${reason}` : '.'}`)
    return
  }
  markInLibrary('pixabay', result.id, item.id)
  useSceneStock.setState((s) => ({
    searches: Object.fromEntries(
      Object.entries(s.searches).map(([key, search]) => [
        key,
        { ...search, results: search.results.map((r) => (r.id === result.id ? { ...r, libraryId: item.id } : r)) },
      ]),
    ),
  }))
  if (!placeFootage(sceneId, item)) setFailure(sceneId, 'That scene no longer exists.')
}
