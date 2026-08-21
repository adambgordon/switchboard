/**
 * Pure logic behind the app-wide tooltip (`TooltipLayer.tsx`): how long a label may be, and where it
 * goes once its size is known.
 *
 * Both halves live here rather than in the component because both are arithmetic with edge cases and
 * neither needs a DOM — and the placement half in particular is an ORDERING (try below, then above,
 * then clamp), which is exactly the kind of rule that silently reverts to a broken form if it has no
 * test reaching it.
 */

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
