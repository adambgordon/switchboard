import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { ConversationMeta, PtyState } from '@shared/types'
import { absShort, formatBytes, formatDuration, formatMetric } from '../lib/format'
import CopyButton from './CopyButton'
import { Close } from './icons'

interface Props {
  /** Open when a target is set; null closes (App owns the {sessionId, edit} target). */
  open: boolean
  meta: ConversationMeta | null
  pty: PtyState | null
  /** Open with the title field focused — the right-click "Rename…" entry point. */
  startInEdit: boolean
  onClose: () => void
  /** Persist a new title; an empty string clears it back to the auto-generated title. */
  onRename: (title: string) => void
}

/**
 * One label · value detail row. The value text is selectable (highlight to copy); `tip` adds a
 * hover tooltip (used to surface the raw token counts), and `copy` adds a one-click copy button
 * (only the Session ID row uses it — everything else is select-to-copy).
 */
function Row({
  label,
  mono,
  tip,
  copy,
  children
}: {
  label: string
  mono?: boolean
  tip?: string
  copy?: string
  children: ReactNode
}) {
  return (
    <div className="sb-info-row">
      <span className="sb-info-label label-caps">{label}</span>
      <span className={`sb-info-value${mono ? ' mono truncate' : ''}`}>
        {/* When there's a tooltip, anchor it on an inline span that hugs the text — the value cell is
            full-width (flex:1), so a data-tip on it would center the tooltip far to the right. */}
        {tip ? (
          <span data-tip={tip}>{children}</span>
        ) : (
          children
        )}
      </span>
      {copy ? <CopyButton className="sb-info-copy" tip={`Copy ${label.toLowerCase()}`} getText={() => copy} /> : null}
    </div>
  )
}

/**
 * Conversation-info modal — opened by clicking the pane title or a row's right-click "Session details…"
 * (both open in view mode). The conversation title IS the modal heading, edited **in place**: an
 * always-editable input that commits on blur, commits-and-closes on Enter, and reverts on Esc. Below,
 * a list of detail rows whose values are selectable; only Session ID carries a copy button. Rename
 * writes Claude Code's own `custom-title` line (App → window.api.renameConversation).
 */
export default function ConversationInfoModal({ open, meta, pty, startInEdit, onClose, onRename }: Props) {
  const sessionId = meta?.sessionId ?? pty?.sessionId ?? ''
  const title = meta?.title ?? pty?.title ?? 'Untitled'
  const cwd = meta?.cwd ?? pty?.cwd ?? ''
  const branch = meta?.gitBranch && meta.gitBranch !== 'HEAD' ? meta.gitBranch : null
  const model = meta?.model ?? null
  const sizeBytes = meta?.sizeBytes ?? 0
  const outputTokens = meta?.outputTokens ?? 0
  const inputTokens = meta?.inputTokens ?? 0
  const lastActivity = meta?.lastActivityAt ?? meta?.mtime ?? pty?.lastActivity ?? null
  const firstActivity = meta?.firstActivityAt ?? null
  const durationMs =
    firstActivity != null && lastActivity != null && lastActivity > firstActivity
      ? lastActivity - firstActivity
      : null

  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Whether the title input is focused (the user is editing) and whether the next blur-commit should
  // be skipped (Esc-revert / auto-generate discard the in-progress draft).
  const focusedRef = useRef(false)
  const suppressRef = useRef(false)
  // Latest title in a ref so the open-effect can seed the draft WITHOUT a `title` dependency — a live
  // re-index (which updates `title` after a save) must not re-fire it and yank the user out of an edit.
  const titleRef = useRef(title)
  titleRef.current = title

  // Open / target change: reseed the draft and route focus (startInEdit opens straight in the field).
  useEffect(() => {
    if (!open) return
    setDraft(titleRef.current)
    focusedRef.current = false
    if (startInEdit) {
      const id = requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
      return () => cancelAnimationFrame(id)
    }
    panelRef.current?.focus()
  }, [open, sessionId, startInEdit])

  // Live title changes (a rename's re-index, or an external /rename) reflect in the field when the
  // user isn't mid-edit — so an incoming update never clobbers what's being typed.
  useEffect(() => {
    if (open && !focusedRef.current) setDraft(title)
  }, [title, open])

  if (!open) return null

  // Commit on blur only when the title actually changed — saving an unchanged value would needlessly
  // pin a (possibly auto-generated) title as a custom one. The rewind button is the explicit reset.
  const commit = (): void => {
    if (suppressRef.current) {
      suppressRef.current = false
      return
    }
    if (draft.trim() !== title.trim()) onRename(draft)
  }
  const onTitleKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      // Commit (via blur) and dismiss — Enter both saves the title and closes the modal.
      e.preventDefault()
      inputRef.current?.blur() // blur commits
      onClose()
    } else if (e.key === 'Escape') {
      // Revert this edit; stopPropagation so App's Esc doesn't also close the modal (a second Esc,
      // now out of the field, closes it).
      e.preventDefault()
      e.stopPropagation()
      suppressRef.current = true
      setDraft(title)
      inputRef.current?.blur()
    }
  }

  return (
    <div className="sb-modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sb-modal sb-modal-info"
        role="dialog"
        aria-modal="true"
        aria-label="Conversation info"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="sb-modal-head sb-info-head">
          <input
            ref={inputRef}
            className="sb-info-title-input"
            value={draft}
            maxLength={120}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="Conversation title"
            aria-label="Conversation title"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => {
              focusedRef.current = true
            }}
            onBlur={() => {
              focusedRef.current = false
              commit()
            }}
            onKeyDown={onTitleKey}
          />
          <button className="sb-modal-close" onClick={onClose} aria-label="Close">
            <Close size={16} />
          </button>
        </div>

        <div className="sb-info-body">
          <div className="sb-info-grid">
            <Row label="Folder" mono>
              {cwd || '—'}
            </Row>
            {branch && (
              <Row label="Branch" mono>
                {branch}
              </Row>
            )}
            {model && (
              <Row label="Model" mono>
                {model}
              </Row>
            )}
            <Row label="Messages">{meta?.messageCount ?? 0}</Row>
            {sizeBytes > 0 && <Row label="Size">{formatBytes(sizeBytes)}</Row>}
            {durationMs != null && <Row label="Duration">{formatDuration(durationMs)}</Row>}
            {outputTokens > 0 && (
              <Row label="Output" tip={`${outputTokens.toLocaleString()} tokens`}>
                {formatMetric(outputTokens)} tokens
              </Row>
            )}
            {inputTokens > 0 && (
              <Row label="Input + cache" tip={`${inputTokens.toLocaleString()} tokens`}>
                {formatMetric(inputTokens)} tokens
              </Row>
            )}
            {lastActivity != null && <Row label="Last active">{absShort(lastActivity)}</Row>}
            {pty && (
              <>
                <Row label="Status">
                  <span className="sb-info-live">
                    <span className="sb-dot" />
                    Live
                  </span>
                </Row>
                <Row label="Started">{absShort(pty.startedAt)}</Row>
              </>
            )}
            <Row label="Session ID" mono copy={sessionId}>
              {sessionId || '—'}
            </Row>
          </div>
        </div>
      </div>
    </div>
  )
}
