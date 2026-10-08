import { Merge, Scissors, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Segmented } from '../../components/ui/Segmented'
import type { Scene, SceneSource } from '../../state/project/types'
import { useUi } from '../../state/ui'
import { playback } from '../preview/playback'
import { TimeField } from '../ranking/TimeField'
import { SceneAiShots } from './SceneAiShots'
import { mergeScene, removeScene, selectScene, setSceneTime, splitSceneAt, updateScene } from './sceneEdits'
import { SceneFootage } from './SceneFootage'
import { MAX_SHOT_SECONDS, sceneLength } from './sceneOps'
import styles from './Scenes.module.css'

const SOURCES = [
  { value: 'ai', label: 'AI', title: 'An AI clip made by ComfyUI from the prompt' },
  { value: 'stock', label: 'Stock', title: 'Stock footage from Pixabay' },
  { value: 'none', label: 'None', title: 'Nothing for now' },
] as const satisfies readonly { value: SceneSource; label: string; title: string }[]

interface SceneCardProps {
  scene: Scene
  number: number
  isLast: boolean
  /** The words in the scene's time. */
  narration: string
}

/** One scene: its time, narration, source and picture. */
export function SceneCard({ scene, number, isLast, narration }: SceneCardProps) {
  const ref = useRef<HTMLLIElement>(null)
  /** Set while the card itself picks the scene (a click in it), which must not scroll it. */
  const pickedHere = useRef(false)
  const selected = useUi((s) => s.selectedSceneId === scene.id)
  // Why a typed time wasn't used; it goes once the scene's time changes.
  const [timeMessage, setTimeMessage] = useState<{ text: string; at: string } | null>(null)
  const timeKey = `${scene.start}-${scene.end}`
  const showMessage = (text: string | null) => setTimeMessage(text ? { text, at: timeKey } : null)
  const length = sceneLength(scene)
  const tooLong = scene.source === 'ai' && length > MAX_SHOT_SECONDS + 1e-3

  // Picked on the Scenes lane: bring it into view. (Not when picked by a click in the card: the
  // scroll would move what you're clicking away from under the pointer.)
  useEffect(() => {
    if (selected && !pickedHere.current) ref.current?.scrollIntoView?.({ block: 'nearest' })
    pickedHere.current = false
  }, [selected])

  function pick() {
    if (selected) return
    pickedHere.current = true
    selectScene(scene.id)
  }

  return (
    <li
      ref={ref}
      className={`${styles.card} ${selected ? styles.selected : ''}`}
      data-testid="scene"
      aria-label={`Scene ${number}`}
      onPointerDown={pick}
      onFocus={pick}
    >
      <div className={styles.head}>
        <button
          type="button"
          className={styles.number}
          title="Show it in the preview"
          onClick={() => {
            pick()
            playback.seek(scene.start)
          }}
        >
          Scene {number}
        </button>
        <span className={styles.times}>
          <TimeField label={`Start of scene ${number}`} value={scene.start} onApply={(text) => setSceneTime(scene.id, 'start', text)} onMessage={showMessage} />
          <span aria-hidden>–</span>
          <TimeField label={`End of scene ${number}`} value={scene.end} onApply={(text) => setSceneTime(scene.id, 'end', text)} onMessage={showMessage} />
        </span>
        <span className={styles.length}>{length.toFixed(1)} s</span>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Split scene ${number}`}
            title="Split: at the playhead if it's in this scene, else in the middle"
            onClick={() => splitSceneAt(scene.id)}
          >
            <Scissors size={13} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Merge scene ${number} with the next`}
            title="Merge with the next scene"
            disabled={isLast}
            onClick={() => mergeScene(scene.id)}
          >
            <Merge size={13} />
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.danger}`}
            aria-label={`Delete scene ${number}`}
            title="Delete this scene (its previews are kept; Undo brings it back)"
            onClick={() => removeScene(scene.id)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {timeMessage?.at === timeKey && (
        <p className={styles.warning} role="alert" data-testid="scene-time-message">
          <TriangleAlert size={11} aria-hidden /> {timeMessage.text}
        </p>
      )}

      <p className={styles.narration} data-testid="scene-narration" title="The words in this scene's time">
        {narration}
      </p>

      <Segmented label={`Source of scene ${number}`} options={SOURCES} value={scene.source} onChange={(source) => updateScene(scene.id, { source })} />

      <label className={styles.field}>
        <span className={styles.label}>Visual description</span>
        <textarea
          className={styles.text}
          rows={2}
          value={scene.description}
          maxLength={2000}
          placeholder="What's on screen, e.g. a close-up of an airplane window"
          aria-label={`Visual description of scene ${number}`}
          onChange={(event) => updateScene(scene.id, { description: event.target.value }, 'description')}
        />
      </label>

      {scene.source === 'ai' && <SceneAiShots scene={scene} number={number} />}
      {scene.source === 'stock' && <SceneFootage scene={scene} number={number} />}

      {tooLong && (
        <p className={styles.warning}>
          <TriangleAlert size={11} aria-hidden /> Longer than {MAX_SHOT_SECONDS} s: AI clips fall apart beyond about {MAX_SHOT_SECONDS} seconds, so its
          previews are {MAX_SHOT_SECONDS} s. Split it.
        </p>
      )}
    </li>
  )
}
