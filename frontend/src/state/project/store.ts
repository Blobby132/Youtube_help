import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { createProject } from './defaults'
import type { Project } from './types'

interface ProjectState {
  project: Project
  /** False until a project has been loaded from (or created on) the backend. */
  loaded: boolean
  /** Replaces the whole project, e.g. after New or Open. */
  replace: (project: Project) => void
  /** Edits the project in place with an Immer recipe. */
  update: (recipe: (draft: Project) => void) => void
}

export const useProjectStore = create<ProjectState>()(
  immer((set) => ({
    project: createProject(),
    loaded: false,
    replace: (project) => set({ project, loaded: true }),
    update: (recipe) =>
      set((state) => {
        recipe(state.project)
      }),
  })),
)

/** Shorthand for components: `const script = useProject((p) => p.script)`. */
export function useProject<T>(selector: (project: Project) => T): T {
  return useProjectStore((state) => selector(state.project))
}

export const updateProject = (recipe: (draft: Project) => void) =>
  useProjectStore.getState().update(recipe)
