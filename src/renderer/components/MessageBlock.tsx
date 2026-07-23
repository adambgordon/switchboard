import { Children, isValidElement, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import java from 'highlight.js/lib/languages/java'
import bash from 'highlight.js/lib/languages/bash'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import markdown from 'highlight.js/lib/languages/markdown'
import type { TranscriptBlock } from '@shared/types'
import type { ToolCall, ToolPair, ToolRunItem, TranscriptItem } from '../lib/messageGroups'
import { clockTime, fullDateTime } from '../lib/format'
import { rowsToMarkdownTable, turnMarkdown } from '../lib/clipboard'
import { langLabelFromClassName } from '../lib/codeLang'
import CopyButton from './CopyButton'
import AgentLogo from './AgentLogo'
import { Arrow, Chevron, Person } from './icons'

/* Syntax highlighting — a curated language subset (passed to rehype-highlight, which REPLACES lowlight's
 * default ~37 'common' grammars, keeping the bundle lean). Unknown languages are tolerated (a build-time
 * file warning, never a throw), so an unlisted ```fence just renders unstyled. NOTE: html lives in `xml`
 * and shell in `bash` (aliases ```ts / ```py / ```html resolve automatically). The token COLORS live in
 * transcript.css (.hljs-*), themed per light/dark — the one sanctioned exception to the transcript's
 * otherwise strict grayscale (see the header note there). */
const HLJS_LANGUAGES = { python, javascript, typescript, json, java, bash, go, rust, sql, yaml, xml, css, markdown }
// Annotated so the literal is read as a plugin tuple (PluggableList), not a nested array.
const rehypePlugins: ComponentPropsWithoutRef<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeHighlight, { languages: HLJS_LANGUAGES }]
]

/** Read a rendered markdown table's cells into rows (row 0 = header). Shared by the table copy button
 *  and the turn copy. */
function tableRows(table: HTMLTableElement | null): string[][] {
  if (!table) return []
  return Array.from(table.rows).map((row) => Array.from(row.cells).map((c) => c.textContent ?? ''))
}

/** The fence's language, read off the child <code>'s `language-xxx` class (set by rehype-highlight /
 *  mdast). Null for bare fences and inline code. */
function codeLang(children: ReactNode): string | null {
  const code = Children.toArray(children).find(isValidElement)
  const className = isValidElement(code)
    ? (code.props as { className?: string }).className
    : undefined
  return langLabelFromClassName(className)
}

/* A fenced code block + a markdown table each get a corner copy button. The button lives on a
 * non-scrolling `position:relative` wrapper so it stays put while the inner block scrolls sideways.
 * A languaged fence also gets a quiet caps caption in the top-left gutter (`.md-lang`); it lives
 * OUTSIDE the <pre> so it never lands in the copied text, and `.has-lang` opens the gutter so it
 * clears line 1. */
function CodeBlock({ children }: { children?: ReactNode }): ReactNode {
  const ref = useRef<HTMLPreElement>(null)
  const lang = codeLang(children)
  return (
    <div className={lang ? 'md-pre-wrap has-lang' : 'md-pre-wrap'} data-lang={lang ?? undefined}>
      {lang ? (
        <span className="md-lang label-caps" aria-hidden="true">
          {lang}
        </span>
      ) : null}
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
  // Merge the incoming className: rehype-highlight sets `hljs language-xxx` on fenced <code> plus the
  // token <span class="hljs-*"> children — clobbering className with a bare "md-code" would drop the
  // highlight hooks. The highlighted spans arrive as `children`, so rendering them as-is preserves them.
  code: ({ className, children, ...rest }: ComponentPropsWithoutRef<'code'>) => (
    <code className={['md-code', className].filter(Boolean).join(' ')} {...rest}>
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

/* ------------------------------------------------------------------ *
 * Tool result — the output block: a sunken card, danger red (border +
 * wash) when isError, clamped to 6 lines with a Show more toggle.
 * Rendered inside a tool run (below its call), never standalone.
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
  // The whole block toggles when there's more to show/hide — unless the user is drag-selecting text
  // (that leaves a non-empty selection; a plain click doesn't). CopyButton stops its own propagation,
  // so copy clicks never reach here.
  const cardClass = ['tool-card', 'result-card', isError ? 'is-error' : ''].filter(Boolean).join(' ')
  const clipClass = ['tool-result-clip', expanded ? 'is-expanded' : 'is-clamped', overflowing ? 'has-more' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cardClass}>
      <CopyButton className="copy-block" tip="Copy result" getText={() => text} />
      <div className="tool-result-body">
        <div ref={clipRef} className={clipClass}>
          <pre ref={textRef} className="tool-result-text">
            {text}
          </pre>
        </div>
      </div>
      {overflowing ? (
        <>
          {/* Only the bottom strip (≈ the fade zone) toggles — the rest of the block keeps its normal
              text-selection / I-beam. This zone owns the hover (revealing the label + the expanded fade)
              and the click; a drag-select starting above it still works. */}
          <div className="tool-result-toggle" onClick={() => setExpanded((v) => !v)} aria-hidden="true" />
          <span className="show-more">
            {expanded ? 'Collapse' : 'Expand'}
            <Arrow size={12} className={expanded ? 'show-more-arrow' : 'show-more-arrow is-down'} />
          </span>
        </>
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

/** One tool call inside an expanded run: a static "⚙ Name" head over its (always-shown) input JSON.
 *  Non-collapsing — the run's disclosure is the only toggle, so one click reveals everything. */
function ToolCallView({ call }: { call: ToolCall }): ReactNode {
  const hasInput = call.input !== undefined && call.input !== null
  return (
    <div className="tool-call">
      <div className="tool-head mono">
        <span aria-hidden="true">⚙</span>
        <span className="tool-name">{call.name}</span>
      </div>
      {hasInput ? (
        <div className="tool-json-wrap">
          <pre className="tool-json">{safeStringify(call.input)}</pre>
          <CopyButton className="copy-block" tip="Copy JSON" getText={() => safeStringify(call.input)} />
        </div>
      ) : null}
    </div>
  )
}

/** A call paired with its output: the "⚙ Name" call, then a quiet ↳ marker over the result block.
 *  A pending call (live turn / blocking tool) shows an "Awaiting output…" note; an orphan result
 *  (call truncated/compacted away) shows on its own. */
function ToolPairView({ pair }: { pair: ToolPair }): ReactNode {
  return (
    <div className="tool-pair">
      {pair.call ? <ToolCallView call={pair.call} /> : null}
      {pair.result ? (
        <div className="tool-result">
          <div className="tool-head mono result-head">
            <span aria-hidden="true">↳</span>
            <span className={pair.result.isError ? 'tool-name is-error' : 'tool-name'}>
              {pair.result.isError ? 'Error' : 'Result'}
            </span>
          </div>
          <ToolResultBlock text={pair.result.text} isError={pair.result.isError} />
        </div>
      ) : pair.call ? (
        <div className="tool-pending label-caps">Awaiting output…</div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tool run — a maximal stretch of consecutive tool activity collapses
 * behind ONE "⚙ N tool calls" disclosure (sibling of the earlier tool
 * head grammar). Native (uncontrolled) <details>: browser-instant
 * toggle, find-in-conversation opens it for free, open-state tracked
 * only to word the tooltip. Expanding shows every call + its result.
 * ------------------------------------------------------------------ */
function ToolRun({ item }: { item: ToolRunItem }): ReactNode {
  const [open, setOpen] = useState(false)
  const noun = item.count === 1 ? 'tool call' : 'tool calls'
  return (
    <details className="tool-run" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="tool-head tool-toggle mono">
        {/* No gear on the run header itself — the individual calls inside keep theirs. data-tip rides
            the label cluster (not the full-width summary) so the tooltip anchors beside the cursor. The
            noun matches the count so a single-call run reads "tool call" (label + tooltip). */}
        <span className="disclosure-label" data-tip={`${open ? 'Collapse' : 'Expand'} ${noun}`}>
          <Chevron className="run-chevron" size={13} />
          <span className="tool-name">
            <span className="tool-count">{item.count}</span>
            {` ${noun}`}
          </span>
        </span>
      </summary>
      <div className="tool-run-body">
        {item.pairs.map((pair) => (
          <ToolPairView key={pair.key} pair={pair} />
        ))}
      </div>
    </details>
  )
}

function renderBlock(block: TranscriptBlock, role: 'user' | 'assistant', key: string): ReactNode {
  if (block.kind === 'text') {
    return role === 'assistant' ? (
      <AssistantMarkdown key={key} text={block.text} />
    ) : (
      <pre key={key} className="user-text">
        {block.text}
      </pre>
    )
  }
  if (block.kind === 'image') return <ImageBlock key={key} alt={block.alt} />
  // tool_use / tool_result are consumed by a tool run, never rendered inside a prose turn.
  return null
}

/* ------------------------------------------------------------------ *
 * One TranscriptItem — a same-author SECTION (one header for a whole
 * stretch: the agent's prose beats + tool runs, or the human turn), or
 * the interrupt sentinel (a standalone muted note). Consecutive same-
 * author content shares the single header; the You↔agent divider marks
 * the section break. (Keeps the name MessageBlock — the map unit.)
 * ------------------------------------------------------------------ */
function MessageBlock({
  item,
  dividerBefore
}: {
  item: TranscriptItem
  dividerBefore: boolean
}): ReactNode {
  if (item.kind === 'interrupt') {
    return (
      <div className="message message-interrupt">
        <span className="interrupt-note label-caps">Interrupted</span>
      </div>
    )
  }

  // A hairline above this section when it crosses the You↔agent boundary (computed in TranscriptView).
  const classes = `message${item.isSidechain ? ' is-sidechain' : ''}${dividerBefore ? ' has-divider' : ''}`
  const ts = item.timestamp
  const time = clockTime(ts)
  // Copy-turn grabs all narration across the section's prose beats (turnMarkdown skips non-text, so
  // tool runs never land in the copy); shown only when the section carries prose text.
  const proseMessages = item.items.flatMap((it) => (it.kind === 'turn' ? it.messages : []))
  const hasProse = proseMessages.some((m) => m.blocks.some((b) => b.kind === 'text'))

  return (
    <article className={classes}>
      <header className="message-meta">
        <span className="role-label label-caps">
          {item.isAssistant ? (
            <AgentLogo agent={item.agent} size={12} />
          ) : (
            <Person className="role-icon" size={12} />
          )}
          <span className="role-name">{item.label}</span>
        </span>
        {item.isSidechain ? <span className="sidechain-tag label-caps">Sub-agent</span> : null}
        {hasProse ? (
          <CopyButton className="copy-turn" tip="Copy turn" getText={() => turnMarkdown(proseMessages)} />
        ) : null}
        {time ? (
          <span className="message-time" data-tip={fullDateTime(ts)}>
            {time}
          </span>
        ) : null}
      </header>
      <div className="message-body">
        {item.items.map((it) =>
          it.kind === 'turn' ? (
            <div className="prose-beat" key={it.key}>
              {it.messages.flatMap((m) =>
                m.blocks.map((block, bi) => renderBlock(block, m.role, `${m.uuid}:${bi}`))
              )}
            </div>
          ) : (
            <ToolRun key={it.key} item={it} />
          )
        )}
      </div>
    </article>
  )
}

export default memo(MessageBlock)
