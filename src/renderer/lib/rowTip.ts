import { endClampTip } from './tooltip'

/**
 * What a rail row's hover says, beyond what the row shows: its full title, its preview, and a quiet
 * line naming its folder (and the worktree or subdirectory it ran in, when that isn't the folder
 * itself). The last-activity time is added by the tooltip at reveal — see `tipMetaLine`.
 *
 * Each field is END-clamped to its own budget here, before it reaches the tooltip layer, which exempts
 * the rail and the tab strip from its middle-cut: these are prose and paths read from the start, not
 * URLs. The tab strip clamps its hover with the same helpers — a tab and its row describe one
 * conversation, and must not cut it two ways.
 */

export const TIP_TITLE_MAX = 200
export const TIP_PREVIEW_MAX = 320
export const TIP_META_MAX = 120

/**
 * Where a conversation ran, relative to its folder: nothing at the project root, the path below it for
 * a subdirectory, else the directory's own name — a linked worktree lives outside the repo it folds
 * into, and its name is the branch-like label a reader recognizes.
 */
export function tipPlace(cwd: string, root: string): string {
  if (cwd === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (cwd.startsWith(prefix)) return cwd.slice(prefix.length)
  const parts = cwd.split('/').filter((s) => s.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : cwd
}

/** What the row's own markers say, since those carry no label of their own: the row's tooltip takes
 *  over the whole row (see `data-tip-scrub`), so it names them in its last line instead. */
export interface RowTipNotes {
  /** A Claude background session — the dashed ring around the logo. */
  background: boolean
  /** Another window holds the conversation's tab — the window glyph. */
  elsewhere: boolean
}

/**
 * The tooltip's third line after its age: the folder's label, the place within it, then what the row's
 * markers mean.
 */
export function rowTipMeta(label: string, cwd: string, root: string, notes: RowTipNotes): string {
  const parts = [
    label,
    tipPlace(cwd, root),
    notes.background ? 'Background session' : '',
    notes.elsewhere ? 'In another window' : ''
  ]
  return endClampTip(parts.filter((s) => s.length > 0).join(' · '), TIP_META_MAX)
}

export const rowTipTitle = (title: string): string => endClampTip(title, TIP_TITLE_MAX)

/** Null when there is no preview: a tooltip has no height to hold, so it omits the line. */
export const rowTipPreview = (preview: string | null): string | null =>
  preview ? endClampTip(preview, TIP_PREVIEW_MAX) : null
