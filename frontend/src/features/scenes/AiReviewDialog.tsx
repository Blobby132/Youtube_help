import { useMemo } from 'react'
import { Button } from '../../components/ui/Button'
import { Checkbox } from '../../components/ui/Checkbox'
import { Modal } from '../../components/ui/Modal'
import { useProject } from '../../state/project/store'
import type { SceneSource } from '../../state/project/types'
import { describeMerge, describeSplit, FIELD_LABEL, reviewWrite, SOURCE_LABEL, type Question } from './aiWrite'
import { applyReview, closeReview, discardReview, setChoice, useLlm } from './llmStore'
import styles from './Scenes.module.css'

const shown = (question: Question, text: string) => (question.field === 'source' ? SOURCE_LABEL[text as SceneSource] : text)

/** Asks before the language model's text replaces fields you've edited, and before it changes the cuts. */
export function AiReviewDialog() {
  const pending = useLlm((s) => s.pending)
  const open = useLlm((s) => s.reviewOpen && s.pending !== null)
  const scenes = useProject((p) => p.scenes)
  // Against the scenes as they are now: you can keep editing while it's open.
  const review = useMemo(() => (pending ? reviewWrite(scenes, pending.sent, pending.result) : null), [scenes, pending])
  if (!pending || !review) return null
  const { choices } = pending
  // A scene merged into the one before it takes that one's text, so its own questions don't apply.
  const mergedAway = new Set(review.merges.filter((m) => choices.merges.includes(m.key)).map((m) => m.next))
  const changes = review.merges.length + review.splits.length

  return (
    <Modal title="Write scenes with AI" open={open} onClose={closeReview}>
      <div className={styles.review} data-testid="llm-review">
        <p>
          {pending.result.model} wrote {review.written} {review.written === 1 ? 'scene' : 'scenes'}. Its text goes into every field you haven’t
          edited. {review.questions.length ? 'For the fields you have, choose below.' : ''} Undo (Ctrl+Z) brings back what was there.
        </p>

        {review.questions.length > 0 && (
          <section aria-label="Fields you've edited">
            <h3>Fields you’ve edited</h3>
            <ul className={styles.questions}>
              {review.questions.map((question) => {
                const useAi = choices.useAi.includes(question.key)
                const away = mergedAway.has(question.sceneId)
                const name = `Scene ${question.number} · ${FIELD_LABEL[question.field]}`
                return (
                  <li key={question.key} data-testid="llm-question" className={away ? styles.away : undefined}>
                    <span className={styles.questionName}>
                      {name}
                      {away && ' (merged into the scene before, so its text is used)'}
                    </span>
                    <label className={styles.choice}>
                      <input type="radio" name={question.key} checked={!useAi} disabled={away} onChange={() => setChoice('useAi', question.key, false)} />
                      <span>
                        <b>Keep mine:</b> {shown(question, question.mine)}
                      </span>
                    </label>
                    <label className={styles.choice}>
                      <input type="radio" name={question.key} checked={useAi} disabled={away} onChange={() => setChoice('useAi', question.key, true)} />
                      <span>
                        <b>Use the AI’s:</b> {shown(question, question.ai)}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {changes > 0 && (
          <section aria-label="Changes to the cuts">
            <h3>Changes to the cuts</h3>
            <p className={styles.note}>Each keeps every scene 2 to 5 seconds long and cuts where a word starts. Untick the ones you don’t want.</p>
            <ul className={styles.questions}>
              {review.merges.map((merge) => (
                <li key={merge.key} data-testid="llm-change">
                  <Checkbox label={describeMerge(merge)} checked={choices.merges.includes(merge.key)} onChange={(on) => setChoice('merges', merge.key, on)} />
                  {merge.why && <span className={styles.why}>{merge.why}</span>}
                  {merge.replacesEdits.length > 0 && (
                    <span className={styles.previewOld}>
                      Replaces your {merge.replacesEdits.map((f) => FIELD_LABEL[f].toLowerCase()).join(' and ')} in scene {merge.number + 1}.
                    </span>
                  )}
                </li>
              ))}
              {review.splits.map((split) => (
                <li key={split.key} data-testid="llm-change">
                  <Checkbox label={describeSplit(split)} checked={choices.splits.includes(split.key)} onChange={(on) => setChoice('splits', split.key, on)} />
                  {split.why && <span className={styles.why}>{split.why}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {review.skipped.length > 0 && (
          <section aria-label="Left out">
            <h3>Left out</h3>
            <ul className={styles.skipped}>
              {review.skipped.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </section>
        )}

        <div className={styles.askActions}>
          <Button variant="primary" onClick={applyReview}>
            Apply
          </Button>
          <Button variant="ghost" onClick={discardReview} title="Change nothing: the language model’s text is thrown away">
            Discard
          </Button>
        </div>
      </div>
    </Modal>
  )
}
