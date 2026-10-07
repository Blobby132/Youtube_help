import { Film, Image as ImageIcon, Library, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Checkbox } from '../../components/ui/Checkbox'
import { EmptyState } from '../../components/ui/EmptyState'
import { InlineAlert } from '../../components/ui/InlineAlert'
import { libraryFileUrl, libraryThumbnailUrl, type LibraryItem, type MediaSource } from '../../lib/api'
import { formatClipLength } from '../../lib/time'
import { useProject } from '../../state/project/store'
import { addToTimeline } from '../timeline/timelineEdits'
import { endMediaDrag, startMediaDrag } from './dragMedia'
import styles from './Library.module.css'
import { clearLibraryError, deleteItem, updateItem, useLibrary } from './libraryStore'

const SOURCE_LABEL: Record<MediaSource, string> = { pexels: 'Pexels', upload: 'Imported', ai: 'AI shot' }

/** Every clip in the shared library. Drag one onto the timeline, or use +. */
export function LibraryList() {
  const { items, status, error } = useLibrary()
  const used = useProject((p) => p.clips)
  const onTimeline = new Set(used.map((c) => c.mediaId))

  return (
    <>
      {error && (
        <InlineAlert>
          <p>{error}</p>
          <button type="button" className={styles.dismiss} onClick={clearLibraryError}>
            Dismiss
          </button>
        </InlineAlert>
      )}
      {status === 'loading' && !items.length && <p className={styles.note}>Loading the library…</p>}
      {status === 'ready' && !items.length && (
        <EmptyState icon={Library}>Nothing here yet. Clips you add from Pexels or import appear here, for all your projects.</EmptyState>
      )}
      {items.length > 0 && (
        <ul className={styles.list} aria-label="Library">
          {items.map((item) => (
            <LibraryCard key={item.id} item={item} onTimeline={onTimeline.has(item.id)} />
          ))}
        </ul>
      )}
    </>
  )
}

function LibraryCard({ item, onTimeline }: { item: LibraryItem; onTimeline: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <li
      className={styles.card}
      draggable
      onDragStart={(event) => startMediaDrag(event, item)}
      onDragEnd={endMediaDrag}
      aria-label={item.name}
      data-testid="library-item"
    >
      <div className={styles.thumb} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {item.thumbnail && <img src={libraryThumbnailUrl(item.id)} alt="" loading="lazy" draggable={false} />}
        {hover && item.kind === 'video' && <video src={libraryFileUrl(item.id)} muted autoPlay loop playsInline />}
        <span className={styles.kind} aria-hidden>
          {item.kind === 'video' ? <Film size={10} /> : <ImageIcon size={10} />}
        </span>
      </div>
      <div className={styles.info}>
        <span className={styles.name} title={item.originalName ? `${item.name} (${item.originalName})` : item.name}>
          {item.name}
        </span>
        <span className={styles.meta}>
          {item.width}×{item.height} · {item.duration ? formatClipLength(item.duration) : 'Image'} · {SOURCE_LABEL[item.source]}
        </span>
        <span className={styles.badges}>
          {item.lowRes && (
            <span className={styles.lowRes} title={`Narrower than 1080 pixels (${item.width}×${item.height}): it's scaled up to fill the frame and may look soft.`}>
              Low res
            </span>
          )}
          {item.aiGenerated && (
            <span className={styles.ai} title="AI-generated">
              <Sparkles size={9} aria-hidden /> AI
            </span>
          )}
          {onTimeline && <span className={styles.used}>On timeline</span>}
        </span>
        {item.pexels && (
          <a className={styles.creditLink} href={item.pexels.url} target="_blank" rel="noreferrer">
            by {item.pexels.photographer} on Pexels
          </a>
        )}
        <div className={styles.actions}>
          <Checkbox
            label="AI-generated"
            checked={item.aiGenerated}
            onChange={(checked) => void updateItem(item.id, { aiGenerated: checked })}
          />
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Add “${item.name}” to the timeline`}
            title="Add to the timeline (first gap, or the end)"
            onClick={() => addToTimeline(item)}
          >
            <Plus size={13} />
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.danger}`}
            aria-label={`Delete “${item.name}” from the library`}
            title="Delete from the library"
            onClick={() => void deleteItem(item.id)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </li>
  )
}
