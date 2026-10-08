// The text over the video at a given time: the title, the ranking overlay and the caption.
// The preview draws it with this code, and so does the final render: it draws every
// different overlay with drawFrameOverlays onto a transparent 1080x1920 canvas and FFmpeg lays
// those images over the video (see ../render/overlayFrames.ts). Line breaks, sizes and
// positions are worked out once, here and in the layout files, with the same font files.
import type { Captions, Project, RankEntry, Ranking, TitleSettings } from '../../state/project/types'
import { hasTitle, rankTop, titleShown } from '../canvas/overlayLayout'
import { activeWordIndex, type CaptionGroup, groupCaptions, groupIndexAt } from '../captions/captionGroups'
import { rankAt } from '../ranking/rankEntries'
import { drawCaption } from './drawCaptions'
import { drawRank, drawTitle, measureTitle } from './drawOverlays'

/** What the overlays are drawn from: the project's settings plus its captions in groups. */
export interface OverlayScene {
  title: TitleSettings
  ranking: Ranking
  captions: Captions
  groups: CaptionGroup[]
}

/** The scene for a project. Pass the previous scene to reuse its caption groups when the words didn't change. */
export function overlayScene(project: Pick<Project, 'canvas' | 'ranking' | 'captions'>, previous?: OverlayScene | null): OverlayScene {
  const { captions } = project
  const reuse =
    previous &&
    previous.captions.words === captions.words &&
    previous.captions.style.wordsPerCaption === captions.style.wordsPerCaption
  return {
    title: project.canvas.title,
    ranking: project.ranking,
    captions,
    groups: reuse ? previous.groups : groupCaptions(captions.words, captions.style.wordsPerCaption),
  }
}

/** What's on screen at one moment. Two moments with the same state look the same. */
export interface OverlayState {
  title: boolean
  rank: { entry: RankEntry; rank: number } | null
  caption: { index: number; group: CaptionGroup; active: number } | null
}

export function overlayState(scene: OverlayScene, time: number): OverlayState {
  const { captions, groups } = scene
  let caption: OverlayState['caption'] = null
  if (captions.enabled && groups.length) {
    const index = groupIndexAt(groups, time)
    const group = groups[index]
    // With one word per caption there's no highlight (drawCaption), so the word can't change.
    if (group) caption = { index, group, active: group.words.length > 1 ? activeWordIndex(group, time) : -1 }
  }
  return { title: titleShown(scene.title, time), rank: rankAt(scene.ranking, time), caption }
}

/** Equal keys mean equal pictures. */
export function overlayKey(state: OverlayState): string {
  const rank = state.rank ? `${state.rank.entry.id}#${state.rank.rank}` : ''
  const caption = state.caption ? `${state.caption.index}.${state.caption.active}` : ''
  return `${state.title ? 'T' : ''}|${rank}|${caption}`
}

export const isEmpty = (state: OverlayState) => !state.title && !state.rank && !state.caption

/** Fonts the overlays use (load them before drawing). */
export function overlayFonts(scene: OverlayScene): string[] {
  const fonts = new Set<string>()
  if (hasTitle(scene.title)) fonts.add(scene.title.fontId)
  if (scene.ranking.enabled && scene.ranking.entries.length) fonts.add(scene.ranking.style.fontId)
  if (scene.captions.enabled && scene.captions.words.length) fonts.add(scene.captions.style.fontId)
  return [...fonts]
}

/** Draws the title, the ranking and the caption, in that order, onto a 1080x1920 canvas. */
export function drawFrameOverlays(ctx: CanvasRenderingContext2D, scene: OverlayScene, state: OverlayState, time: number) {
  const { title, ranking, captions } = scene
  // Measured even while the title isn't shown: the ranking keeps its place under it.
  const titleLayout = hasTitle(title) ? measureTitle(ctx, title) : null
  if (titleLayout && state.title) drawTitle(ctx, title, titleLayout)
  if (state.rank) drawRank(ctx, state.rank.entry, state.rank.rank, ranking.style, rankTop(titleLayout?.bottom ?? null))
  if (state.caption) drawCaption(ctx, state.caption.group, time, captions.style)
}
