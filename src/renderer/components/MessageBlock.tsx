import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TranscriptBlock } from '@shared/types'
import type { MessageGroup } from '../lib/messageGroups'
import { clockTime, fullDateTime } from '../lib/format'
import { rowsToMarkdownTable, turnMarkdown } from '../lib/clipboard'
import { Check, Copy } from './icons'

/* ------------------------------------------------------------------ *
 * Copy affordance — a hover-revealed icon button that flashes a check
 * for ~700ms on click (the TallyRail.copySessionId pattern). Neutral
 * ink only (copy isn't an accent action). `getText` is read lazily on
 * click, so callers pull from a ref / the DOM / props at that moment.
 * ------------------------------------------------------------------ */
function CopyButton({
  getText,
  className,
  tip = 'Copy'
}: {
  getText: () => string
  className?: string
  tip?: string
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const onClick = (e: ReactMouseEvent): void => {
    // Never toggle a surrounding <details>, start a text selection, or bubble to the pane.
    e.preventDefault()
    e.stopPropagation()
    const text = getText()
    if (!text) return
    void navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 700)
  }
  return (
    <button
      type="button"
      className={`copy-btn${className ? ' ' + className : ''}${copied ? ' copied' : ''}`}
      onClick={onClick}
      aria-label={tip}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

/** Read a rendered markdown table's cells into rows (row 0 = header). Shared by the table copy button
 *  and the turn copy. */
function tableRows(table: HTMLTableElement | null): string[][] {
  if (!table) return []
  return Array.from(table.rows).map((row) => Array.from(row.cells).map((c) => c.textContent ?? ''))
}

/* A fenced code block + a markdown table each get a corner copy button. The button lives on a
 * non-scrolling `position:relative` wrapper so it stays put while the inner block scrolls sideways. */
function CodeBlock({ children }: { children?: ReactNode }): ReactNode {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div className="md-pre-wrap">
      <pre className="md-pre" ref={ref}>
        {children}
      </pre>
      <CopyButton className="copy-block" tip="Copy code" getText={() => ref.current?.textContent ?? ''} />
    </div>
  )
}

function TableBlock({
  children,
  sourceMarkdown
}: {
  children?: ReactNode
  /** The table's exact markdown source (sliced via the hast node's position). Preferred over the DOM
   *  reconstruction because it preserves cell formatting / alignment that the rendered cells drop. */
  sourceMarkdown?: string
}): ReactNode {
  const ref = useRef<HTMLTableElement>(null)
  const getText = (): string => sourceMarkdown?.trim() || rowsToMarkdownTable(tableRows(ref.current))
  return (
    <div className="md-table-outer">
      <div className="md-table-wrap">
        <table className="md-table" ref={ref}>
          {children}
        </table>
      </div>
      <CopyButton className="copy-block" tip="Copy table" getText={getText} />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Markdown overrides — every element is styled via a `md-*` class so
 * the look lives entirely in transcript.css. Links never navigate;
 * they hand off to the OS browser via window.api.openExternal.
 * ------------------------------------------------------------------ */
const markdownComponents: Components = {
  p: ({ children }) => <p className="md-p">{children}</p>,
  a: ({ href, children }) => (
    <a
      className="md-a"
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) window.api.openExternal(href)
      }}
    >
      {children}
    </a>
  ),
  // Inline code is a bare <code>; fenced blocks render inside <pre>.
  // CSS distinguishes the two via `.md-code` vs `pre.md-pre .md-code`.
  code: ({ children, ...rest }: ComponentPropsWithoutRef<'code'>) => (
    <code className="md-code" {...rest}>
      {children}
    </code>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  ul: ({ children }) => <ul className="md-ul">{children}</ul>,
  ol: ({ children }) => <ol className="md-ol">{children}</ol>,
  li: ({ children }) => <li className="md-li">{children}</li>,
  h1: ({ children }) => <h1 className="md-h md-h1">{children}</h1>,
  h2: ({ children }) => <h2 className="md-h md-h2">{children}</h2>,
  h3: ({ children }) => <h3 className="md-h md-h3">{children}</h3>,
  h4: ({ children }) => <h4 className="md-h md-h4">{children}</h4>,
  h5: ({ children }) => <h5 className="md-h md-h5">{children}</h5>,
  h6: ({ children }) => <h6 className="md-h md-h6">{children}</h6>,
  blockquote: ({ children }) => <blockquote className="md-quote">{children}</blockquote>,
  th: ({ children, style }) => (
    <th className="md-th" style={style}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="md-td" style={style}>
      {children}
    </td>
  ),
  hr: () => <hr className="md-hr" />,
  strong: ({ children }) => <strong className="md-strong">{children}</strong>,
  em: ({ children }) => <em className="md-em">{children}</em>,
  img: ({ alt }) => (
    <span className="block-chip">
      <span aria-hidden="true">🖼</span>
      <span>{alt && alt.trim() ? alt : 'image'}</span>
    </span>
  )
}

/** Slice an element's exact markdown source from the original `text` via its hast node position.
 *  Returns '' when offsets are unavailable (callers fall back to a DOM-based reconstruction). */
function sliceSource(text: string, node: unknown): string {
  const pos = (
    node as { position?: { start?: { offset?: number }; end?: { offset?: number } } } | undefined
  )?.position
  const start = pos?.start?.offset
  const end = pos?.end?.offset
  return typeof start === 'number' && typeof end === 'number' ? text.slice(start, end) : ''
}

function AssistantMarkdown({ text }: { text: string }): ReactNode {
  // Override `table` with a closure over the source so its copy button yields the exact markdown
  // (cell formatting / alignment preserved) sliced via the node's position offsets — the same source
  // the turn copy uses. Everything else stays the shared module-level components.
  const components = useMemo<Components>(
    () => ({
      ...markdownComponents,
      table: ({ node, children }) => (
        <TableBlock sourceMarkdown={sliceSource(text, node)}>{children}</TableBlock>
      )
    }),
    [text]
  )
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tool use — compact secondary card; input is collapsed pretty JSON.
 * ------------------------------------------------------------------ */
function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function ToolUseBlock({ name, input }: { name: string; input: unknown }): ReactNode {
  const hasInput = input !== undefined && input !== null
  // No input → a static "⚙ Name" label. With input → the whole "⚙ Name" row IS the disclosure
  // toggle (a rotating chevron via CSS); clicking it expands the JSON. No separate "Input" row.
  if (!hasInput) {
    return (
      <div className="tool-card">
        <div className="tool-head mono">
          <span aria-hidden="true">⚙</span>
          <span className="tool-name">{name}</span>
        </div>
      </div>
    )
  }
  return (
    <details className="tool-card">
      <summary className="tool-head tool-toggle mono">
        <span aria-hidden="true">⚙</span>
        <span className="tool-name">{name}</span>
      </summary>
      <div className="tool-json-wrap">
        <pre className="tool-json">{safeStringify(input)}</pre>
        <CopyButton className="copy-block" tip="Copy JSON" getText={() => safeStringify(input)} />
      </div>
    </details>
  )
}

/* ------------------------------------------------------------------ *
 * Tool result — neutral card; danger red (border + wash) when isError.
 * The Result/Error attribution lives in the message header now, so the
 * card carries no internal label.
 * ------------------------------------------------------------------ */
function ToolResultBlock({ text, isError }: { text: string; isError: boolean }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const clipRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLPreElement>(null)
  // Show the toggle only when the clamp actually hides content: scrollHeight (full text) beats the
  // clip's clamped clientHeight. A single mount-time read raced the layout (clamp height not settled
  // → looked like "fits" → no button), so re-measure via a ResizeObserver on the text — it fires once
  // the text lays out, on font load, and on re-wrap. Collapsed only; expanded keeps the flag so
  // "Show less" stays.
  useLayoutEffect(() => {
    if (expanded) return
    const clip = clipRef.current
    const txt = textRef.current
    if (!clip || !txt) return
    const measure = (): void => setOverflowing(clip.scrollHeight - clip.clientHeight > 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(txt)
    return () => ro.disconnect()
  }, [text, expanded])
  // Find-in-conversation reveals a match hidden in the clamped tail by dispatching `sb-reveal` on
  // the clip — expand so the active highlight becomes visible (see useTranscriptSearch).
  useEffect(() => {
    const clip = clipRef.current
    if (!clip) return
    const onReveal = (): void => setExpanded(true)
    clip.addEventListener('sb-reveal', onReveal)
    return () => clip.removeEventListener('sb-reveal', onReveal)
  }, [])
  return (
    <div className={isError ? 'tool-card result-card is-error' : 'tool-card result-card'}>
      <CopyButton className="copy-block" tip="Copy result" getText={() => text} />
      <div className="tool-result-body">
        <div
          ref={clipRef}
          className={`tool-result-clip${expanded ? '' : ' is-clamped'}${!expanded && overflowing ? ' is-faded' : ''}`}
        >
          <pre ref={textRef} className="tool-result-text">
            {text}
          </pre>
        </div>
      </div>
      {overflowing ? (
        <button
          type="button"
          className="show-more label-caps"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  )
}

function ImageBlock({ alt }: { alt: string }): ReactNode {
  return (
    <span className="block-chip">
      <span aria-hidden="true">🖼</span>
      <span>{alt && alt.trim() ? alt : 'image'}</span>
    </span>
  )
}

function renderBlock(block: TranscriptBlock, role: 'user' | 'assistant', key: string): ReactNode {
  switch (block.kind) {
    case 'text':
      if (role === 'assistant') {
        return <AssistantMarkdown key={key} text={block.text} />
      }
      return (
        <pre key={key} className="user-text">
          {block.text}
        </pre>
      )
    case 'tool_use':
      return <ToolUseBlock key={key} name={block.name} input={block.input} />
    case 'tool_result':
      return <ToolResultBlock key={key} text={block.text} isError={block.isError} />
    case 'image':
      return <ImageBlock key={key} alt={block.alt} />
    default:
      return null
  }
}

/* ------------------------------------------------------------------ *
 * One coalesced group: a run of consecutive same-source messages shown
 * under a single header (Claude / You / Result / Error). The interrupt
 * sentinel renders as a standalone muted divider instead. (The component
 * keeps the name MessageBlock — it's the unit the transcript maps over.)
 * ------------------------------------------------------------------ */
function MessageBlock({
  group,
  dividerBefore
}: {
  group: MessageGroup
  dividerBefore: boolean
}): ReactNode {
  if (group.interrupted) {
    return (
      <div className="message message-interrupt">
        <span className="interrupt-note label-caps">Interrupted</span>
      </div>
    )
  }

  // A hairline above this group when it crosses the You↔non-You boundary (computed in TranscriptView).
  const classes = `message${group.isSidechain ? ' is-sidechain' : ''}${
    dividerBefore ? ' has-divider' : ''
  }`
  const ts = group.messages[0]?.timestamp ?? null
  const time = clockTime(ts)
  // The turn-copy icon is for narrative turns only: You / Claude groups that actually carry prose
  // (a text block). Result / Error / Interrupted and pure-tool-call turns have no prose — their
  // content is reachable via the per-block copy buttons instead.
  const isProseTurn =
    (group.label === 'You' || group.label === 'Claude') &&
    group.messages.some((m) => m.blocks.some((b) => b.kind === 'text'))

  return (
    <article className={classes}>
      <header className="message-meta">
        <span className={group.isError ? 'role-label label-caps is-error' : 'role-label label-caps'}>
          {group.label}
        </span>
        {group.isSidechain ? <span className="sidechain-tag label-caps">Sub-agent</span> : null}
        {isProseTurn ? (
          <CopyButton
            className="copy-turn"
            tip="Copy turn"
            getText={() => turnMarkdown(group.messages)}
          />
        ) : null}
        {time ? (
          <span className="message-time mono" data-tip={fullDateTime(ts)}>
            {time}
          </span>
        ) : null}
      </header>
      <div className="message-body">
        {group.messages.flatMap((m) =>
          m.blocks.map((block, bi) => renderBlock(block, m.role, `${m.uuid}:${bi}`))
        )}
      </div>
    </article>
  )
}

export default memo(MessageBlock)
