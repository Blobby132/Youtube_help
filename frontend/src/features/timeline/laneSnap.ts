// What an edge dragged on the Ranks or Scenes lane snaps to: words, caption changes, clip edges,
// the playhead and the ends of the video.
import { projectDuration } from '../../state/project/selectors'
import { useProjectStore } from '../../state/project/store'
import { useUi } from '../../state/ui'
import { groupCaptions } from '../captions/captionGroups'
import { clipEnd } from './clipOps'
import { snapPoints, type SnapPoint } from './snap'

export function laneSnapPoints(): SnapPoint[] {
  const project = useProjectStore.getState().project
  const { words, style } = project.captions
  return snapPoints({
    words,
    groups: groupCaptions(words, style.wordsPerCaption),
    clipEdges: project.clips.flatMap((c) => [c.start, clipEnd(c)]),
    playhead: useUi.getState().playhead,
    end: projectDuration(project),
  })
}

export const SNAP_LABEL: Record<SnapPoint['kind'], string> = {
  word: 'word',
  caption: 'caption',
  clip: 'clip',
  playhead: 'playhead',
  edge: 'end',
}
