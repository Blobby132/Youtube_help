// Dragging a library item onto the timeline. Browsers hide drag data until the drop, so the
// item being dragged is also kept here for the drop preview.
import type { LibraryItem } from '../../lib/api'

export const MEDIA_DRAG_TYPE = 'application/x-shorts-media'

let dragged: LibraryItem | null = null

export function startMediaDrag(event: DragEvent | React.DragEvent, item: LibraryItem) {
  event.dataTransfer?.setData(MEDIA_DRAG_TYPE, item.id)
  event.dataTransfer?.setData('text/plain', item.name)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
  dragged = item
}

export function endMediaDrag() {
  dragged = null
}

export const draggedMedia = () => dragged
