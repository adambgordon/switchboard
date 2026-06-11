import type { PtyState } from '@shared/types'
import type { ResolvedTheme } from '../lib/theme'
import TerminalView from './TerminalView'

interface Props {
  activePtys: PtyState[]
  visiblePtyId: string | null
  deckVisible: boolean
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
export default function TerminalDeck({ activePtys, visiblePtyId, deckVisible, focusReq, theme, onMarkUnread }: Props) {
  return (
    <div className="sb-term-deck" style={{ display: deckVisible ? 'block' : 'none' }}>
      {activePtys.map((p) => {
        const isVisible = deckVisible && p.ptyId === visiblePtyId
        // A focus request aimed at this session passes its bump counter down; every other
        // terminal gets null and so never auto-focuses just from becoming visible.
        const focusKey = focusReq && focusReq.sessionId === p.sessionId ? focusReq.n : null
        return (
          <div
            key={p.ptyId}
            className="sb-term-host"
            style={{ display: isVisible ? 'block' : 'none' }}
          >
            <TerminalView
              ptyId={p.ptyId}
              sessionId={p.sessionId}
              visible={isVisible}
              focusKey={focusKey}
              theme={theme}
              onMarkUnread={onMarkUnread}
            />
          </div>
        )
      })}
    </div>
  )
}
