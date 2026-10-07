import { Check, Download, Film, LoaderCircle, Search, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Segmented } from '../../components/ui/Segmented'
import type { PexelsResult } from '../../lib/api'
import { formatDuration } from '../../lib/time'
import { useUi } from '../../state/ui'
import { endMediaDrag, startMediaDrag } from '../library/dragMedia'
import { addFromPexels, dismissDownload, useLibrary } from '../library/libraryStore'
import styles from './MediaPanel.module.css'
import { loadMorePexels, markInLibrary, searchPexels, setOrientation, usePexels, type Orientation } from './pexelsStore'

const ORIENTATIONS = [
  { value: 'portrait', label: 'Portrait', title: 'Only vertical videos (best for Shorts)' },
  { value: 'any', label: 'Any', title: 'All videos, vertical ones first; wide ones are cropped to 9:16' },
] as const

/** Search Pexels, preview results on hover, and add them to the library. */
export function PexelsSearch() {
  const pexelsReady = useUi((s) => s.health?.pexels)
  const { query, orientation, results, status, error, hasMore, total } = usePexels()
  const [text, setText] = useState(query)
  const searching = status === 'searching'
  const downloads = useLibrary((s) => s.downloads)
  const failed = results.filter((r) => downloads[r.id]?.error)

  return (
    <>
      <form
        className={styles.search}
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          void searchPexels(text)
        }}
      >
        <Search size={14} className={styles.searchIcon} aria-hidden />
        <input
          className={styles.searchInput}
          type="search"
          placeholder="airplane window, ocean, city at night…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label="Search Pexels"
        />
        <Button type="submit" variant="primary" size="sm" loading={searching} disabled={!text.trim()}>
          Search
        </Button>
      </form>
      <div className={styles.searchOptions}>
        <div className={styles.orientation}>
          <Segmented<Orientation>
            label="Orientation"
            options={ORIENTATIONS}
            value={orientation}
            onChange={(value) => setOrientation(value)}
          />
        </div>
        {status === 'done' && (
          <span className={styles.count}>
            {total.toLocaleString()} {total === 1 ? 'video' : 'videos'}
          </span>
        )}
      </div>

      {pexelsReady === false && !error && (
        <InlineAlert tone="info">
          Add your free Pexels API key to <code>.env</code> as <code>PEXELS_API_KEY</code>, then restart the app.
        </InlineAlert>
      )}
      {error && <InlineAlert>{error}</InlineAlert>}
      {failed.map((result) => (
        <InlineAlert key={result.id}>
          <p>
            Could not add “{result.title}”: {downloads[result.id].error}
          </p>
          <button type="button" className={styles.dismiss} onClick={() => dismissDownload(result.id)}>
            <X size={11} aria-hidden /> Dismiss
          </button>
        </InlineAlert>
      ))}

      {results.length > 0 ? (
        <>
          <ul className={styles.grid} aria-label="Pexels results">
            {results.map((result) => (
              <PexelsTile key={result.id} result={result} />
            ))}
          </ul>
          {hasMore && (
            <Button size="sm" block loading={status === 'more'} onClick={() => void loadMorePexels()}>
              More results
            </Button>
          )}
          <p className={styles.credit}>
            Videos from{' '}
            <a href="https://www.pexels.com" target="_blank" rel="noreferrer">
              Pexels
            </a>
            , free to use. Hover to preview.
          </p>
        </>
      ) : (
        status !== 'searching' &&
        (status === 'done' ? (
          <EmptyState icon={Film}>No videos found for “{query}”. Try other words.</EmptyState>
        ) : (
          !error && <EmptyState icon={Film}>Search results appear here. Hover a clip to preview it.</EmptyState>
        ))
      )}
    </>
  )
}

function PexelsTile({ result }: { result: PexelsResult }) {
  const [hover, setHover] = useState(false)
  const download = useLibrary((s) => s.downloads[result.id])
  const item = useLibrary((s) => (result.libraryId ? s.items.find((i) => i.id === result.libraryId) : undefined))
  const portrait = result.height > result.width
  const busy = download && !download.error

  async function add() {
    const added = await addFromPexels(result.id)
    if (added) markInLibrary(result.id, added.id)
  }

  return (
    <li
      className={styles.tile}
      draggable={!!item}
      onDragStart={item ? (event) => startMediaDrag(event, item) : undefined}
      onDragEnd={endMediaDrag}
      title={`${result.title} · by ${result.photographer}`}
    >
      <div className={styles.tileThumb} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <img src={result.image} alt="" loading="lazy" draggable={false} />
        {hover && result.previewUrl && <video src={result.previewUrl} muted autoPlay loop playsInline />}
        <span className={styles.tileDuration}>{formatDuration(result.duration)}</span>
        {!portrait && <span className={styles.tileTag}>Wide</span>}
        {busy && (
          <div className={styles.tileProgress} role="progressbar" aria-valuenow={Math.round(download.progress * 100)} aria-label={download.message}>
            <span style={{ width: `${Math.max(4, download.progress * 100)}%` }} />
          </div>
        )}
      </div>
      <div className={styles.tileFooter}>
        <span className={styles.tileRes} title="The file that will be downloaded">
          {result.file.width}×{result.file.height}
        </span>
        {result.libraryId ? (
          <span className={styles.inLibrary} title="In your library: drag it onto the timeline">
            <Check size={12} aria-hidden /> In library
          </span>
        ) : (
          <button
            type="button"
            className={styles.tileAdd}
            onClick={() => void add()}
            disabled={busy}
            aria-label={`Add “${result.title}” to the library`}
            title={busy ? download.message : 'Download into your library'}
          >
            {busy ? <LoaderCircle size={12} className={styles.spin} aria-hidden /> : <Download size={12} aria-hidden />}
            {busy ? `${Math.round(download.progress * 100)}%` : 'Add'}
          </button>
        )}
      </div>
    </li>
  )
}
