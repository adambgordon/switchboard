import type { PtyState } from '@shared/types'
import type { ResolvedTheme } from '../lib/theme'
import TerminalView from './TerminalView'

interface Props {
  activePtys: PtyState[]
  homes: Record<string, number>
  paneHosts: Array<HTMLElement | null>
  visiblePtyIds: Array<string | null>
  /** A focus request: `{ sessionId, n }` where `n` is a bump counter. Only the matching
   *  session's TerminalView receives a non-null `focusKey`. */
  focusReq: { sessionId: string; n: number } | null
  /** Resolved app theme, forwarded to each TerminalView for live re-skinning. */
  theme: ResolvedTheme
  /** Option+click in a terminal — always mark that conversation unread (never toggles). */
  onMarkUnread: (id: string) => void
}

/**
 * Keeps one <TerminalView> mounted per live session so scrollback survives
 * switching. Only the selected one is shown; the rest are display:none (their
 * xterm instances stay alive). This is what makes bouncing between live sessions
 * instant.
 */
export default function TerminalDeck({
  activePtys,
  homes,
  paneHosts,
  visiblePtyIds,
  focusReq,
  theme,
  onMarkUnread
}: Props) {
  return (
    <>
      {activePtys.map((p) => {
        const pane = homes[p.ptyId]
        if (pane == null) return null
        const mountNode = paneHosts[pane] ?? paneHosts[0]
        if (!mountNode) return null
        const isVisible = visiblePtyIds[pane] === p.ptyId
        // A focus request aimed at this session passes its bump counter down; every other
        // terminal gets null and so never auto-focuses just from becoming visible.
        const focusKey = focusReq && focusReq.sessionId === p.sessionId ? focusReq.n : null
        return (
          <TerminalView
            key={p.ptyId}
            mountNode={mountNode}
            ptyId={p.ptyId}
            sessionId={p.sessionId}
            agent={p.agent}
            visible={isVisible}
            focusKey={focusKey}
            theme={theme}
            onMarkUnread={onMarkUnread}
          />
        )
      })}
    </>
  )
}
