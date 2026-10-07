import { describe, expect, it } from 'vitest'
import type { ComfyStatus } from '../../lib/api'
import { generateBlocker } from './generateStore'

const status = (overrides: Partial<ComfyStatus> = {}): ComfyStatus => ({
  reachable: true,
  url: 'http://127.0.0.1:8188',
  error: null,
  workflow: 'ltx_t2v_api.json',
  workflowProblem: null,
  ...overrides,
})

describe('Generate shot availability', () => {
  it('is available when ComfyUI answers and the workflow is fine', () => {
    expect(generateBlocker(status(), true)).toBeNull()
  })

  it('explains that ComfyUI Desktop needs to be open', () => {
    expect(generateBlocker(status({ reachable: false }), true)).toBe('Open ComfyUI Desktop first: Generate shot uses it to make the clips.')
  })

  it('names a workflow problem first, and waits for the backend and the first check', () => {
    const problem = "ltx_t2v_api.json can't be used: Duration (seconds) is missing."
    expect(generateBlocker(status({ reachable: false, workflowProblem: problem }), true)).toBe(problem)
    expect(generateBlocker(status(), false)).toBe('The backend is not running.')
    expect(generateBlocker(null, true)).toBe('Checking ComfyUI…')
  })
})
