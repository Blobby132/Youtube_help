import { Check, Film, LoaderCircle, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import type { StockResult } from '../../lib/api'
import { formatDuration, formatTimecode } from '../../lib/time'
import { useProject } from '../../state/project/store'
import type { Scene } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { downloadKey, useLibrary } from '../library/libraryStore'
import mediaStyles from '../media/MediaPanel.module.css'
import { clearBlock, useStock } from '../media/stockStore'
import { updateScene } from './sceneEdits'
import styles from './Scenes.module.css'
import { chooseFootage, closeSearch, findFootage, useSceneStock } from './sceneStock'

const ORIENTATION_LABEL = { portrait: 'Portrait', landscape: 'Landscape', square: 'Square' } as const

/** A stock scene: its search text, and Pixabay footage to put over it. */
export function SceneFootage({ scene, number }: { scene: Scene; number: number }) {
  const hasKey = useUi((s) => !!s.health?.pixabay)
  const checked = useUi((s) => s.health !== null)
  const search = useSceneStock((s) => s.searches[scene.id])
  const failure = useSceneStock((s) => s.failures[scene.id])
  const blockedUntil = useStock((s) => s.blockedUntil.pixabay)
  const item = useLibrary((s) => (scene.stockItemId ? s.items.find((i) => i.id === scene.stockItemId) : undefined))
  const onTimeline = useProject((p) => p.clips.some((c) => c.mediaId === scene.stockItemId && c.start < scene.end && c.start + c.duration > scene.start))
  const blocked = blockedUntil !== undefined

  // Pixabay's rate limit resets on its own: let the button work again then (the Media tab's
  // countdown clears it too).
  useEffect(() => {
    if (!blockedUntil) return
    const timer = setTimeout(() => clearBlock('pixabay'), Math.max(0, blockedUntil - Date.now()))
    return () => clearTimeout(timer)
  }, [blockedUntil])

  return (
    <>
      <label className={styles.field}>
        <span className={styles.label}>Stock search text</span>
        <input
          className={styles.input}
          value={scene.searchText}
          maxLength={100}
          placeholder="What to search Pixabay for, e.g. airplane window"
          aria-label={`Stock search text of scene ${number}`}
          onChange={(event) => updateScene(scene.id, { searchText: event.target.value }, 'searchText')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && hasKey && !blocked) void findFootage(scene.id)
          }}
        />
      </label>
      <Button
        block
        icon={Search}
        loading={search?.status === 'searching'}
        disabled={!hasKey || !scene.searchText.trim() || blocked}
        title={blocked ? 'Pixabay’s rate limit is used up; it resets shortly' : 'Search Pixabay for the search text'}
        onClick={() => void findFootage(scene.id)}
      >
        Find footage
      </Button>
      {checked && !hasKey && (
        <p className={styles.note}>
          Find footage searches Pixabay, which needs a free API key: add <code>PIXABAY_API_KEY</code> to <code>.env</code> (from{' '}
          <a href="https://pixabay.com/api/docs/" target="_blank" rel="noreferrer">
            pixabay.com/api/docs
          </a>
          ), then restart the app.
        </p>
      )}
      {scene.stockItemId && (
        <p className={styles.chosenFootage} data-testid="scene-footage">
          <Check size={12} aria-hidden />
          <span>
            {item ? `“${item.name}”` : 'The chosen clip'} {onTimeline ? 'is on the timeline' : 'was placed'} from {formatTimecode(scene.start)} to{' '}
            {formatTimecode(scene.end)}
            {onTimeline ? '.' : ', but it’s no longer there.'}
          </span>
        </p>
      )}
      {failure && (
        <p className={styles.message} role="alert">
          {failure}
        </p>
      )}
      {search?.status === 'error' && (
        <p className={styles.message} role="alert">
          {search.error}
        </p>
      )}
      {search?.status === 'done' &&
        (search.results.length ? (
          <>
            <ul className={mediaStyles.grid} aria-label={`Pixabay results for scene ${number}`}>
              {search.results.map((result) => (
                <FootageTile key={result.id} result={result} scene={scene} />
              ))}
            </ul>
            <p className={mediaStyles.credit}>
              Videos from{' '}
              <a href="https://pixabay.com" target="_blank" rel="noreferrer">
                Pixabay
              </a>
              , free to use. Hover to preview; Use downloads one and puts it on the timeline over this scene.{' '}
              <button type="button" className={mediaStyles.dismiss} onClick={() => closeSearch(scene.id)}>
                <X size={11} aria-hidden /> Close
              </button>
            </p>
          </>
        ) : (
          <p className={styles.note}>No Pixabay videos found for “{search.query}”. Try other words.</p>
        ))}
    </>
  )
}

function FootageTile({ result, scene }: { result: StockResult; scene: Scene }) {
  const [hover, setHover] = useState(false)
  const download = useLibrary((s) => s.downloads[downloadKey(result.source, result.id)])
  const using = useLibrary((s) => !!scene.stockItemId && s.items.find((i) => i.id === scene.stockItemId)?.pixabay?.videoId === result.id)
  const busy = !!download && !download.error

  return (
    <li className={`${mediaStyles.tile} ${using ? styles.using : ''}`} title={`${result.title} · by ${result.author} on Pixabay`} data-testid="footage-result">
      <div className={mediaStyles.tileThumb} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {result.image ? <img src={result.image} alt="" loading="lazy" draggable={false} /> : <Film size={14} className={styles.thumbIcon} aria-hidden />}
        {hover && result.previewUrl && <video src={result.previewUrl} muted autoPlay loop playsInline />}
        <span className={mediaStyles.tileDuration}>{formatDuration(result.duration)}</span>
        <span className={`${mediaStyles.tileTag} ${result.orientation === 'portrait' ? mediaStyles.tagPortrait : ''}`}>
          {ORIENTATION_LABEL[result.orientation]}
        </span>
        {busy && (
          <div className={mediaStyles.tileProgress} role="progressbar" aria-valuenow={Math.round(download.progress * 100)} aria-label={download.message}>
            <span style={{ width: `${Math.max(4, download.progress * 100)}%` }} />
          </div>
        )}
      </div>
      <div className={mediaStyles.tileFooter}>
        <span className={mediaStyles.tileRes}>
          {result.file.width}×{result.file.height}
        </span>
        {using ? (
          <span className={mediaStyles.inLibrary}>
            <Check size={12} aria-hidden /> Using
          </span>
        ) : (
          <button
            type="button"
            className={mediaStyles.tileAdd}
            disabled={busy}
            aria-label={`Use “${result.title}” for this scene`}
            title={busy ? download.message : 'Put it on the timeline over this scene'}
            onClick={() => void chooseFootage(scene.id, result)}
          >
            {busy ? <LoaderCircle size={12} className={mediaStyles.spin} aria-hidden /> : null}
            {busy ? `${Math.round(download.progress * 100)}%` : 'Use'}
          </button>
        )}
      </div>
    </li>
  )
}
