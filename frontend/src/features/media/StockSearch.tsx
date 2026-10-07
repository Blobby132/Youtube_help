import { Check, Download, Film, LoaderCircle, Search, Timer, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { Segmented } from '../../components/ui/Segmented'
import type { Orientation, StockResult, StockSource } from '../../lib/api'
import { formatDuration } from '../../lib/time'
import { useUi } from '../../state/ui'
import { endMediaDrag, startMediaDrag } from '../library/dragMedia'
import { addFromStock, dismissDownload, downloadKey, useLibrary } from '../library/libraryStore'
import styles from './MediaPanel.module.css'
import { availableSources, formatWait, SOURCE_LABEL, SOURCE_SITE } from './stockSources'
import {
  clearBlock,
  loadMoreStock,
  markInLibrary,
  pickSource,
  searchStock,
  setOrientation,
  useCurrentSource,
  useStock,
} from './stockStore'

const ORIENTATIONS = [
  { value: 'portrait', label: 'Portrait', title: 'Only vertical videos (best for Shorts)' },
  { value: 'landscape', label: 'Landscape', title: 'Only wide videos; they are cropped to 9:16' },
  { value: 'any', label: 'Any', title: 'All videos, vertical ones first' },
] as const

const ORIENTATION_LABEL = { portrait: 'Portrait', landscape: 'Landscape', square: 'Square' } as const

/** Seconds left on a rate limit, ticking down; null when not limited. */
function useWait(source: StockSource): number | null {
  const until = useStock((s) => s.blockedUntil[source])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!until) return
    const timer = setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= until) clearBlock(source)
    }, 500)
    return () => clearInterval(timer)
  }, [until, source])
  return until && until > now ? (until - now) / 1000 : null
}

/** Search Pexels or Pixabay, preview results on hover, and add them to the library. */
export function StockSearch() {
  const health = useUi((s) => s.health)
  const available = availableSources(health)
  const source = useCurrentSource()
  const { query, orientation, results, status, error, hasMore, total, totalExact } = useStock()
  const shownSource = useStock((s) => s.source) ?? source
  const [text, setText] = useState(query)
  const wait = useWait(source)
  const searching = status === 'searching'
  const downloads = useLibrary((s) => s.downloads)
  const failed = results.filter((r) => downloads[downloadKey(r.source, r.id)]?.error)

  return (
    <>
      {available.length > 1 && (
        <div className={styles.sourceRow}>
          <span className={styles.rowLabel}>Source</span>
          <div className={styles.sourceSwitch}>
            <Segmented<StockSource>
              label="Stock video source"
              options={available.map((value) => ({ value, label: SOURCE_LABEL[value] }))}
              value={source}
              onChange={pickSource}
            />
          </div>
        </div>
      )}
      <form
        className={styles.search}
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          void searchStock(text)
        }}
      >
        <Search size={14} className={styles.searchIcon} aria-hidden />
        <input
          className={styles.searchInput}
          type="search"
          placeholder={`Search ${SOURCE_LABEL[source]}: ocean, city at night…`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label={`Search ${SOURCE_LABEL[source]}`}
        />
        <Button type="submit" variant="primary" size="sm" loading={searching} disabled={!text.trim() || wait !== null}>
          {wait !== null ? formatWait(wait) : 'Search'}
        </Button>
      </form>
      <Segmented<Orientation> label="Orientation" options={ORIENTATIONS} value={orientation} onChange={setOrientation} />

      {health && available.length === 0 && !error && (
        <InlineAlert tone="info">
          Add a free Pixabay API key to <code>.env</code> as <code>PIXABAY_API_KEY</code> (from{' '}
          <a href="https://pixabay.com/api/docs/" target="_blank" rel="noreferrer">
            pixabay.com/api/docs
          </a>
          ), then restart the app. A Pexels key (<code>PEXELS_API_KEY</code>) works too.
        </InlineAlert>
      )}
      {wait !== null ? (
        <InlineAlert tone="warning">
          <p>{error}</p>
          <p className={styles.countdown}>
            <Timer size={12} aria-hidden /> You can search {SOURCE_LABEL[source]} again in {formatWait(wait)}.
          </p>
        </InlineAlert>
      ) : (
        error && <InlineAlert>{error}</InlineAlert>
      )}
      {failed.map((result) => (
        <InlineAlert key={downloadKey(result.source, result.id)}>
          <p>
            Could not add “{result.title}”: {downloads[downloadKey(result.source, result.id)].error}
          </p>
          <button type="button" className={styles.dismiss} onClick={() => dismissDownload(result.source, result.id)}>
            <X size={11} aria-hidden /> Dismiss
          </button>
        </InlineAlert>
      ))}

      {results.length > 0 ? (
        <>
          <ul className={styles.grid} aria-label={`${SOURCE_LABEL[shownSource]} results`}>
            {results.map((result) => (
              <StockTile key={`${result.source}:${result.id}`} result={result} />
            ))}
          </ul>
          {hasMore && (
            <Button size="sm" block loading={status === 'more'} onClick={() => void loadMoreStock()}>
              More results
            </Button>
          )}
          <p className={styles.credit} data-testid="stock-credit">
            {total.toLocaleString()}
            {totalExact ? '' : '+'} {total === 1 ? 'video' : 'videos'} from{' '}
            <a href={SOURCE_SITE[shownSource]} target="_blank" rel="noreferrer">
              {SOURCE_LABEL[shownSource]}
            </a>
            , free to use. Hover to preview; Add downloads a copy into your library.
          </p>
        </>
      ) : (
        status !== 'searching' &&
        (status === 'done' ? (
          <EmptyState icon={Film}>
            No {orientation === 'any' ? '' : `${orientation} `}videos found for “{query}” on {SOURCE_LABEL[shownSource]}. Try other words
            {orientation === 'any' ? '' : ' or another orientation'}.
          </EmptyState>
        ) : (
          !error && <EmptyState icon={Film}>Search results appear here. Hover a clip to preview it.</EmptyState>
        ))
      )}
    </>
  )
}

function StockTile({ result }: { result: StockResult }) {
  const [hover, setHover] = useState(false)
  const download = useLibrary((s) => s.downloads[downloadKey(result.source, result.id)])
  const item = useLibrary((s) => (result.libraryId ? s.items.find((i) => i.id === result.libraryId) : undefined))
  const busy = download && !download.error

  async function add() {
    const added = await addFromStock(result.source, result.id)
    if (added) markInLibrary(result.source, result.id, added.id)
  }

  return (
    <li
      className={styles.tile}
      draggable={!!item}
      onDragStart={item ? (event) => startMediaDrag(event, item) : undefined}
      onDragEnd={endMediaDrag}
      title={`${result.title} · by ${result.author} on ${SOURCE_LABEL[result.source]}`}
    >
      <div className={styles.tileThumb} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {result.image && <img src={result.image} alt="" loading="lazy" draggable={false} />}
        {hover && result.previewUrl && <video src={result.previewUrl} muted autoPlay loop playsInline />}
        <span className={styles.tileDuration}>{formatDuration(result.duration)}</span>
        <span className={`${styles.tileTag} ${result.orientation === 'portrait' ? styles.tagPortrait : ''}`}>
          {ORIENTATION_LABEL[result.orientation]}
        </span>
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
