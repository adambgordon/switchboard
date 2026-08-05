import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { AGENTS } from '@shared/types'
import type { ConversationMeta, PtyState } from '@shared/types'
import { absShort, formatBytes, formatDuration, formatMetric } from '../lib/format'
import AgentLogo from './AgentLogo'
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
 * One label · value detail row. The value text is selectable (highlight to copy); `labelTip` adds a
 * hover tooltip on the KEY describing what the row means, and `copy` adds a one-click copy button
 * (only the Session ID row uses it — everything else is select-to-copy).
 */
function Row({
  label,
  labelTip,
  mono,
  copy,
  children
}: {
  label: string
  labelTip?: string
  mono?: boolean
  copy?: string
  children: ReactNode
}) {
  return (
    <div className="sb-info-row">
      {/* The tooltip rides an inline span hugging the label text — the label cell is a fixed width,
          so a data-tip on it would center the tooltip off to the side of the text. */}
      <span className="sb-info-label label-caps">
        {labelTip ? <span data-tip={labelTip}>{label}</span> : label}
      </span>
      <span className={`sb-info-value${mono ? ' mono truncate' : ''}`}>{children}</span>
      {copy ? <CopyButton className="sb-info-copy" tip={`Copy ${label.toLowerCase()}`} getText={() => copy} /> : null}
    </div>
  )
}

/** A titled group of detail rows — a caps section header above a `.sb-info-grid`. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sb-info-section">
      <div className="sb-info-section-label label-caps">{label}</div>
      <div className="sb-info-grid">{children}</div>
    </div>
  )
}

/**
 * Conversation-info modal — opened by clicking the pane title or a row's right-click "Session details…"
 * (both open in view mode). The conversation title IS the modal heading, edited **in place**: an
 * always-editable input that commits on blur, commits-and-closes on Enter, and reverts on Esc. Below,
 * a list of detail rows whose values are selectable; only Session ID carries a copy button. Rename
 * (App → window.api.renameConversation) is dispatched per agent in main: Claude appends its own
 * `custom-title` line; Codex calls the app-server `thread/name/set` RPC.
 */
export default function ConversationInfoModal({ open, meta, pty, startInEdit, onClose, onRename }: Props) {
  const sessionId = meta?.sessionId ?? pty?.sessionId ?? ''
  const title = meta?.title ?? pty?.title ?? 'Untitled'
  const cwd = meta?.cwd ?? pty?.cwd ?? ''
  const branch = meta?.gitBranch && meta.gitBranch !== 'HEAD' ? meta.gitBranch : null
  const model = meta?.model ?? null
  const agent = meta?.agent ?? pty?.agent ?? 'claude'
  const sizeBytes = meta?.sizeBytes ?? 0
  const outputTokens = meta?.outputTokens ?? 0
  const inputTokens = meta?.inputTokens ?? 0
  const inputBaseTokens = meta?.inputBaseTokens ?? 0
  const cacheWriteTokens = meta?.cacheWriteTokens ?? 0
  const cacheReadTokens = meta?.cacheReadTokens ?? 0
  const cachedInputTokens = meta?.cachedInputTokens ?? 0
  const reasoningTokens = meta?.reasoningTokens ?? 0
  const contextWindow = meta?.contextWindow ?? 0
  const contextTokens = meta?.contextTokens ?? 0
  // Per-agent token categories — never converted/unified (Anthropic tiers and Codex's
  // cached/reasoning split don't map onto each other).
  const hasTokenTotals =
    agent === 'codex'
      ? inputTokens > 0 || cachedInputTokens > 0 || reasoningTokens > 0 || outputTokens > 0
      : inputBaseTokens > 0 || cacheWriteTokens > 0 || cacheReadTokens > 0 || outputTokens > 0
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
          <Section label="Environment">
            <Row label="Agent">
              <span className="sb-info-agent">
                <AgentLogo agent={agent} size={14} />
                {AGENTS[agent].label}
              </span>
            </Row>
            {model && (
              <Row label="Model" mono>
                {model}
              </Row>
            )}
            <Row label="Directory" mono>
              {cwd || '—'}
            </Row>
            {branch && (
              <Row label="Branch" mono>
                {branch}
              </Row>
            )}
          </Section>

          <Section label="Activity">
            <Row label="Messages">{meta?.messageCount ?? 0}</Row>
            {sizeBytes > 0 && <Row label="Size">{formatBytes(sizeBytes)}</Row>}
            {durationMs != null && <Row label="Duration">{formatDuration(durationMs)}</Row>}
          </Section>

          {/* Tokens: the live Context window first, then the cumulative per-tier session totals
              (deduped by message id) — all visible, grouped under one section header. */}
          {(contextTokens > 0 || hasTokenTotals) && (
            <Section label="Tokens">
              {contextTokens > 0 && (
                <Row label="Context" labelTip="Tokens currently in the context window">
                  {contextWindow > 0
                    ? `${formatMetric(contextTokens)} / ${formatMetric(contextWindow)} (${Math.round(
                        (contextTokens / contextWindow) * 100
                      )}%)`
                    : `${formatMetric(contextTokens)} tokens`}
                </Row>
              )}
              {agent === 'codex' ? (
                <>
                  {inputTokens > 0 && (
                    <Row label="Input" labelTip="Total input tokens (including cached)">
                      {formatMetric(inputTokens)} tokens
                    </Row>
                  )}
                  {cachedInputTokens > 0 && (
                    <Row label="Cached input" labelTip="Input tokens served from cache">
                      {formatMetric(cachedInputTokens)} tokens
                    </Row>
                  )}
                  {outputTokens > 0 && (
                    <Row label="Output" labelTip="Output tokens">
                      {formatMetric(outputTokens)} tokens
                    </Row>
                  )}
                  {reasoningTokens > 0 && (
                    <Row label="Reasoning" labelTip="Reasoning output tokens">
                      {formatMetric(reasoningTokens)} tokens
                    </Row>
                  )}
                </>
              ) : (
                <>
                  {inputBaseTokens > 0 && (
                    <Row label="Input" labelTip="Base input tokens">
                      {formatMetric(inputBaseTokens)} tokens
                    </Row>
                  )}
                  {outputTokens > 0 && (
                    <Row label="Output" labelTip="Output tokens">
                      {formatMetric(outputTokens)} tokens
                    </Row>
                  )}
                  {cacheWriteTokens > 0 && (
                    <Row label="Cache write" labelTip="Cache-creation tokens">
                      {formatMetric(cacheWriteTokens)} tokens
                    </Row>
                  )}
                  {cacheReadTokens > 0 && (
                    <Row label="Cache read" labelTip="Cache-read tokens">
                      {formatMetric(cacheReadTokens)} tokens
                    </Row>
                  )}
                </>
              )}
            </Section>
          )}

          <Section label="Session">
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
            {lastActivity != null && <Row label="Last active">{absShort(lastActivity)}</Row>}
            <Row label="Session ID" mono copy={sessionId}>
              {sessionId || '—'}
            </Row>
          </Section>
        </div>
      </div>
    </div>
  )
}
