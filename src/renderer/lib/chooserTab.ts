// Type-only: paneModel imports `isChooserTab`, so a value import here would be a cycle.
import type { PaneLayout } from './paneModel'
import type { AgentKind } from '@shared/types'

/**
 * The new-conversation chooser, as a tab.
 *
 * A chooser occupies a slot in a pane exactly like a conversation does — it opens after the active tab,
 * closes with ⌘W, and is replaced in place by the conversation started from it — so it is modeled as a
 * tab whose id is reserved rather than as a second kind of tab. Every consumer that keys on conversation
 * ids therefore has to skip it, and `isChooserTab` is the one test they use.
 *
 * The prefix contains a character no session id can: both agents' ids and a terminal's placeholder are
 * UUIDs. Ids are minted per window and never leave it — a chooser is not persisted, reported to other
 * windows, or carried by a drag.
 */
const CHOOSER_PREFIX = 'chooser:'

export function chooserTabId(n: number): string {
  return `${CHOOSER_PREFIX}${n}`
}

export function isChooserTab(id: string): boolean {
  return id.startsWith(CHOOSER_PREFIX)
}

/**
 * What ⌘N / ⌘T / the head pencil should do: focus the chooser the user is already on, rather than
 * stacking a second empty one beside it, or open a new one.
 */
export function newConversationTarget(
  layout: PaneLayout
): { kind: 'focus'; id: string } | { kind: 'open' } {
  const active = focusedTab(layout)
  return active !== null && isChooserTab(active) ? { kind: 'focus', id: active } : { kind: 'open' }
}

function focusedTab(layout: PaneLayout): string | null {
  const pane = layout.panes[layout.focusIndex]
  return pane && pane.activeIndex >= 0 ? pane.tabs[pane.activeIndex]?.sessionId ?? null : null
}

/**
 * The agent a chooser shows and starts: the one picked in it while that is still launchable, else the
 * chooser's default. A chooser can open before agent availability is known (a new window opens straight
 * onto one), so a pick made against the assumed set must not outlive learning that it is not installed —
 * or the view would name one agent while Enter started another.
 */
export function chooserAgent(picked: AgentKind, available: readonly AgentKind[], fallback: AgentKind): AgentKind {
  return available.includes(picked) ? picked : fallback
}

/**
 * With tabs off the chooser only ever fills the pane: once something else is on screen it has been left,
 * and a chooser nobody can see or reach (there is no strip) would only be waiting to reappear. So every
 * chooser that is not the focused pane's active tab is stray.
 */
export function strayChoosers(layout: PaneLayout): string[] {
  const active = focusedTab(layout)
  const out: string[] = []
  for (const p of layout.panes) {
    for (const t of p.tabs) if (isChooserTab(t.sessionId) && t.sessionId !== active) out.push(t.sessionId)
  }
  return out
}

/**
 * What a chooser remembers while its view is not mounted — it unmounts whenever its tab is not the
 * active one, and a move to the other pane mounts it afresh — held above the view, per chooser, so it
 * comes back as the user left it. `focus` is the last focus request it acted on: a remount must not act
 * on one again, which would pull the keyboard off the tab strip when arrowing back onto its tab.
 * `picked` is null until an agent is chosen in it.
 */
export interface ChooserMemory {
  focus: number | null
  query: string
  highlight: string | null
  picked: AgentKind | null
}
