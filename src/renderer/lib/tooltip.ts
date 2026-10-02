/**
 * Pure logic behind the app-wide tooltip (`TooltipLayer.tsx`): how long a label may be, and where it
 * goes once its size is known.
 *
 * Both halves live here rather than in the component because both are arithmetic with edge cases and
 * neither needs a DOM — and the placement half in particular is an ORDERING (try below, then above,
 * then clamp), which is exactly the kind of rule that silently reverts to a broken form if it has no
 * test reaching it.
 */

import { META_SEP, relTime } from './format'

/**
 * Longest label we will show, in code points. A `data-tip` carries whatever the host hands it, and a
 * link's tip is its raw href — some of which encode state and run past a thousand characters, enough
 * to wrap into a label taller than the window with nowhere to place it.
 */
export const MAX_TIP = 200

/**
 * Shorten a label to `max`, keeping BOTH ends and marking the cut with an ellipsis.
 *
 * The middle is what goes: for a URL the head carries the origin and path — the thing a tooltip is
 * asked for in the first place — and the tail carries whatever the path ends in, while the middle of
 * an over-long href is almost always encoded state. Cutting only the tail would answer "where does
 * this go" and lose the ending; cutting only the head would do the reverse.
 *
 * Sliced by CODE POINT (`Array.from`), not by UTF-16 unit. A tip can be a conversation title, and
 * titles carry emoji: slicing mid-surrogate-pair would emit a lone surrogate and render as a
 * replacement glyph. Note this is the OPPOSITE of the rule in `mathDelimiters.ts`, and for the
 * opposite reason — that code indexes a buffer whose offsets must line up with `indexOf`, so it must
 * count UTF-16 units; this one bounds a visual length, so a character is the honest unit.
 *
 * (A grapheme CLUSTER can still split — a ZWJ emoji sequence or a flag may lose a joiner and render
 * as its parts. That is cosmetic and confined to the truncated middle, so it is left alone rather
 * than pulling in `Intl.Segmenter` for it.)
 *
 * The ellipsis is fenced by WORD JOINERS (U+2060), which forbid a line break on either side of it.
 * Without them the `…` is the ONLY standard break opportunity in a long URL — base64 offers none — so
 * the line breaker prefers it over an emergency `overflow-wrap` break and leaves a short ragged line
 * with the tail starting fresh below. That reads as two values rather than one truncated one. The
 * joiners take the position out of the running, the line fills to the edge as it does everywhere else,
 * and the `…` sits inline.
 *
 * They are invisible, so they do NOT count against `max` — the cap is on characters a reader sees.
 */
const WJ = '⁠'

export function clampTipText(text: string, max: number = MAX_TIP): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  if (max < 2) return '…'
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = chars.slice(chars.length - (keep - head)).join('')
  return `${chars.slice(0, head).join('')}${WJ}…${WJ}${tail}`
}

/** Visible length of a clamped label — what `max` actually bounds, with the joiners discounted. */
export const visibleTipLength = (text: string): number =>
  Array.from(text).filter((c) => c !== WJ).length

/**
 * Shorten PROSE to `max` code points, cutting the END. A conversation title or preview is read from
 * its start, so the middle-cut above — right for a URL — would splice two unrelated halves of a
 * sentence together. Counted by code point for the same surrogate-pair reason as `clampTipText`.
 */
export function endClampTip(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  if (max < 1) return '…'
  return `${chars.slice(0, max - 1).join('')}…`
}

/**
 * A tooltip's quiet third line: how long ago the host was last active, then whatever the host
 * describes itself with, joined by a middot. The age is formatted HERE, at reveal, from a timestamp
 * rather than baked into the attribute — a host rendered hours ago would otherwise still say "now".
 * Null when there is nothing to say.
 */
export function tipMetaLine(at: number | null, meta: string | null, now: number): string | null {
  const parts: string[] = []
  if (at !== null) {
    const rel = relTime(at, now)
    parts.push(rel === 'now' ? 'Just now' : `${rel} ago`)
  }
  if (meta) parts.push(meta)
  return parts.length > 0 ? parts.join(META_SEP) : null
}

export interface TipBox {
  /** Viewport y of the host's top edge. */
  hostTop: number
  /** Viewport y of the host's bottom edge. */
  hostBottom: number
  /** The label's MEASURED height. The whole point is that this is known before placing. */
  height: number
  /** Viewport height. */
  viewport: number
  /** Space between host and label. */
  gap: number
  /** Smallest allowed margin to the viewport edge. */
  edge: number
}

export interface TipPlacement {
  side: 'top' | 'bottom'
  /** The `top` to set, in the coordinates of that side's transform — `translate(-50%, 0)` for
   *  `bottom`, `translate(-50%, -100%)` for `top`. */
  top: number
}

/**
 * Choose a side and a final `top`, from a label whose height is already known.
 *
 * The ordering is the substance: prefer BELOW when the label fits there, else ABOVE when it fits
 * there, else take whichever side has more room — and in every case clamp so the label stays inside
 * the viewport. The old code chose a side from a fixed 60px probe BEFORE the label existed, which is
 * right for a one-line label and wrong by hundreds of pixels for a wrapped one; there was no vertical
 * clamp behind it to catch the miss.
 *
 * When the label is taller than the viewport no side can hold it, and the clamp pins it to the top
 * edge — still wrong, but wrong in the one direction that keeps the beginning of the text readable.
 */
export function placeTip(box: TipBox): TipPlacement {
  const { hostTop, hostBottom, height, viewport, gap, edge } = box
  const roomBelow = viewport - edge - (hostBottom + gap)
  const roomAbove = hostTop - gap - edge
  const side: 'top' | 'bottom' =
    height <= roomBelow ? 'bottom' : height <= roomAbove ? 'top' : roomBelow >= roomAbove ? 'bottom' : 'top'

  const visualTop = side === 'bottom' ? hostBottom + gap : hostTop - gap - height
  // Clamp to the band the label can occupy. `Math.max(edge, …)` on the lower bound keeps a label
  // taller than the viewport from being pushed UP off the top by a negative ceiling.
  const ceiling = Math.max(edge, viewport - edge - height)
  const clamped = Math.min(Math.max(visualTop, edge), ceiling)
  return { side, top: side === 'bottom' ? clamped : clamped + height }
}

/** Where a label sits beside its host: `left` and `top` of its box, in viewport coordinates. */
export interface SideBox {
  hostTop: number
  hostBottom: number
  hostRight: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  gap: number
  edge: number
}

/**
 * Place a label to the RIGHT of its host, centered on it vertically — for hosts stacked in a column
 * (the rail's rows), where a label above or below would cover the very neighbors the pointer is about
 * to move onto. Clamped into the viewport on both axes; a label taller than the viewport is pinned to
 * the top edge, as in `placeTip`.
 */
export function placeTipRight(box: SideBox): { left: number; top: number } {
  const { hostTop, hostBottom, hostRight, width, height, viewportWidth, viewportHeight, gap, edge } = box
  const centered = (hostTop + hostBottom) / 2 - height / 2
  const top = Math.min(Math.max(centered, edge), Math.max(edge, viewportHeight - edge - height))
  const left = Math.max(edge, Math.min(hostRight + gap, viewportWidth - edge - width))
  return { left, top }
}

/**
 * What the pointer moved onto: no tooltip host (`null`), or a host and the group it belongs to — the
 * nearest `data-tip-group` container, or null for a host in none. Groups compare by identity, so any
 * value that is the same for every host in a container will do.
 */
export type TipTarget = { group: unknown } | null

/**
 * Tooltip groups: once a label is on screen for a host in a group — the rail's rows, a toolbar's
 * buttons — moving onto another host in the SAME group re-fills the label at once instead of waiting
 * out the show delay, so a row of controls can be read by sweeping the pointer along it. `shown` is the
 * group of the label on screen, or null when none is (or it belongs to no group). What a pointer
 * leaving the active host does:
 * - onto another host in that group — `keep`: that host re-fills it;
 * - onto no host at all, like the gap between two buttons — `grace`: hold it briefly, since the pointer
 *   is most likely crossing to the next one, and hiding for one frame would read as a blink;
 * - anything else, or from a label that belongs to no group — `hide`.
 */
export function tipOnLeave(shown: unknown, to: TipTarget): 'keep' | 'grace' | 'hide' {
  if (shown === null) return 'hide'
  if (to === null) return 'grace'
  return to.group === shown ? 'keep' : 'hide'
}

/**
 * What entering a host does:
 * - `refill` — a grouped label is on screen and this host is in its group: re-fill it at once;
 * - `replace` — a grouped label is on screen (within its grace) but this host is not in its group:
 *   dismiss it now, then wait out the delay. Left up, it would describe a control the pointer has left
 *   for the whole delay, and the new host would inherit the old group;
 * - `arm` — otherwise, wait out the delay.
 */
export function tipOnEnter(shown: unknown, to: NonNullable<TipTarget>): 'refill' | 'replace' | 'arm' {
  if (shown === null) return 'arm'
  return to.group === shown ? 'refill' : 'replace'
}
