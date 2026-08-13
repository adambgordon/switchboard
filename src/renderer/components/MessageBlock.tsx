import { Children, isValidElement, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef, MutableRefObject, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
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
import plaintext from 'highlight.js/lib/languages/plaintext'
import type { TranscriptBlock } from '@shared/types'
import type { ToolCall, ToolPair, ToolRunItem, TranscriptItem } from '../lib/messageGroups'
import { clockTime, fullDateTime } from '../lib/format'
import { rowsToMarkdownTable, rowsToPlainText } from '../lib/clipboard'
import { assembleCopy } from '../lib/mdCopy'
import { collectSections, rangeOver, visibleText } from '../lib/mdCopyDom'
import { langLabelFromClassName } from '../lib/codeLang'
import { normalizeMath } from '../lib/mathDelimiters'
import { MathDisplay, MathInline } from './MathBlock'
import CopyButton from './CopyButton'
import AgentLogo from './AgentLogo'
import { Arrow, Chevron, Person } from './icons'

/* Syntax highlighting — a curated language subset (passed to rehype-highlight, which REPLACES lowlight's
 * default ~37 'common' grammars, keeping the bundle lean). Unknown languages are tolerated (a build-time
 * file warning, never a throw), so an unlisted ```fence just renders unstyled. NOTE: html lives in `xml`
 * and shell in `bash` (aliases ```ts / ```py / ```html resolve automatically). The token COLORS live in
 * transcript.css (.hljs-*), themed per light/dark — the one sanctioned exception to the transcript's
 * otherwise strict grayscale (see the header note there). */
// `math` is registered as PLAINTEXT rather than left out: remark-math hands display math to rehype
// as a `language-math` fence, and an unregistered language sends every display formula through
// rehype-highlight's throw/catch + VFile-warning path before the component override replaces it.
// Registering it makes the bypass explicit and keeps the LaTeX one untokenized text child, which is
// what `displayMathTex` reads.
const HLJS_LANGUAGES = { python, javascript, typescript, json, java, bash, go, rust, sql, yaml, xml, css, markdown, math: plaintext }

/* Minimal hast shape — enough to walk and stamp. Avoids pulling in @types/hast (and unist-util-visit)
 * for a dozen lines of tree walk. */
interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
  position?: { start?: { offset?: number }; end?: { offset?: number } }
}

/**
 * Stamp every rendered element with `data-s` / `data-e` — the offsets of the markdown it came from,
 * inside this block's source. This is what lets a text SELECTION be mapped back to markdown (see
 * `lib/mdCopy.ts`); `sliceSource` below already used the same `node.position` offsets to give the table
 * copy button its exact source, so this generalises a mechanism the view was relying on already.
 *
 * Descent stops at `<pre>`: rehype-highlight fills a fence with one token `<span>` per lexeme, and
 * annotating those would multiply the node count on the render path for nothing — the `<pre>`'s own
 * span maps to the fence body on its own (its rendered text occurs exactly once inside its source).
 */
function rehypeSourceOffsets() {
  return (tree: HastNode): void => {
    const visit = (node: HastNode): void => {
      for (const child of node.children ?? []) {
        if (child.type !== 'element') continue
        const s = child.position?.start?.offset
        const e = child.position?.end?.offset
        if (typeof s === 'number' && typeof e === 'number') {
          child.properties = { ...child.properties, 'data-s': s, 'data-e': e }
        }
        if (child.tagName === 'pre') continue
        visit(child)
      }
    }
    visit(tree)
  }
}

// Annotated so the literal is read as a plugin tuple (PluggableList), not a nested array.
const rehypePlugins: ComponentPropsWithoutRef<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeHighlight, { languages: HLJS_LANGUAGES }],
  rehypeSourceOffsets
]

/* Remark plugin sets — three, chosen per block by `normalizeMath` (see lib/mathDelimiters.ts).
 *
 * A block with no math parses EXACTLY as it always has: the math extension never runs, so no `$`
 * in it can be reinterpreted. That is the point of selecting rather than always enabling — the
 * math parser only ever sees a block that proved it wants math, which is also why blocks full of
 * `$PATH` and `${dir}` are untouchable.
 *
 * `singleDollarTextMath` is off in the middle set so `$…$` stays literal while `$$…$$` (the form
 * the `\(…\)` rewrite produces) still reads as inline math. */
type RemarkPlugins = ComponentPropsWithoutRef<typeof ReactMarkdown>['remarkPlugins']
const remarkPlain: RemarkPlugins = [remarkGfm]
const remarkMathOnlyDoubleDollar: RemarkPlugins = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]]
const remarkMathWithSingleDollar: RemarkPlugins = [remarkGfm, [remarkMath, { singleDollarTextMath: true }]]

/** remark-math marks its output with these; rehype-highlight leaves the LaTeX text untokenized. */
const MATH_INLINE = 'math-inline'
const MATH_DISPLAY = 'math-display'

const classNamesOf = (node: unknown): string[] => {
  const raw = (node as HastNode | undefined)?.properties?.className
  if (Array.isArray(raw)) return raw.map(String)
  return typeof raw === 'string' ? raw.split(/\s+/) : []
}

/** The LaTeX inside a `language-math` element — one unsplit text child (see the note above). */
const texOf = (node: unknown): string =>
  ((node as HastNode | undefined)?.children ?? [])
    .map((child) => (child as { value?: string }).value ?? '')
    .join('')

/** A display-math `<pre>` wraps exactly one `language-math math-display` `<code>`. */
function displayMathTex(node: unknown): string | null {
  const kids = (node as HastNode | undefined)?.children ?? []
  const code = kids.find((child) => child.type === 'element' && child.tagName === 'code')
  if (!code || !classNamesOf(code).includes(MATH_DISPLAY)) return null
  return texOf(code)
}

/** The source-offset pair the plugin above stamps, as it arrives in a component's props. Declared so
 *  the two wrapper components (CodeBlock / TableBlock) can forward it onto the element they render. */
type SrcAttrs = { 'data-s'?: number | string; 'data-e'?: number | string }

/** TranscriptView's stable copy context — `enabled` is the Copy-as-markdown preference, read at click
 *  time by the copy buttons so the toggle never touches the render path. */
export type CopyCtxRef = MutableRefObject<{ enabled: boolean; sources: Map<string, string> }>

/**
 * Merge our `md-*` class with whatever hast supplied, instead of letting the spread below overwrite it.
 *
 * The overrides forward `...rest` so the offset attributes reach the DOM, but `rest` carries EVERY hast
 * property — including `className`, and it lands after ours. remark-gfm sets `contains-task-list` on a
 * task list's `<ul>` and `task-list-item` on each `<li>`, and footnotes get `sr-only` / `data-footnote-backref`,
 * so an unmerged spread silently strips `md-ul` / `md-li` / `md-h2` / `md-a` from exactly the content
 * agents emit most. Same trick the `code` override has always used for rehype-highlight's classes.
 */
const cx = (ours: string, theirs?: string): string => [ours, theirs].filter(Boolean).join(' ')

/** Read a rendered markdown table's cells into rows (row 0 = header). Shared by the table copy button
 *  and the turn copy. */
function tableRows(table: HTMLTableElement | null): string[][] {
  if (!table) return []
  // `visibleText`, not `textContent`: a cell can hold a rendered formula, which carries both the
  // glyph layout and the hidden LaTeX source — the shared walk resolves that to one of them.
  return Array.from(table.rows).map((row) => Array.from(row.cells).map((c) => visibleText(c)))
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
function CodeBlock({ children, ...src }: { children?: ReactNode } & SrcAttrs): ReactNode {
  const ref = useRef<HTMLPreElement>(null)
  const lang = codeLang(children)
  return (
    <div className={lang ? 'md-pre-wrap has-lang' : 'md-pre-wrap'} data-lang={lang ?? undefined}>
      {lang ? (
        // data-md-skip: the caption is chrome with no markdown behind it. It renders INSIDE the block
        // but sits outside the annotated <pre>, so counting its text would shift every source offset
        // after it — see the exclusion note in lib/mdCopyDom.ts.
        <span className="md-lang label-caps" aria-hidden="true" data-md-skip="">
          {lang}
        </span>
      ) : null}
      <pre className="md-pre" ref={ref} {...src}>
        {children}
      </pre>
      {/* The rendered <code> carries a trailing newline that isn't part of the code, so strip it —
          otherwise every code copy arrives with a blank line stuck on the end. (The selection path
          gets this for free: assembleCopy trims each part.) */}
      <CopyButton
        className="copy-block"
        tip="Copy code"
        getText={() => (ref.current?.textContent ?? '').replace(/\n+$/, '')}
      />
    </div>
  )
}

function TableBlock({
  children,
  sourceMarkdown,
  copyCtxRef,
  ...src
}: {
  children?: ReactNode
  /** The table's exact markdown source (sliced via the hast node's position). Preferred over the DOM
   *  reconstruction because it preserves cell formatting / alignment that the rendered cells drop. */
  sourceMarkdown?: string
  /** Read at click time — with "Copy as markdown" off, emit tab-separated cells, not a pipe table. */
  copyCtxRef: CopyCtxRef
} & SrcAttrs): ReactNode {
  const ref = useRef<HTMLTableElement>(null)
  const getText = (): string =>
    copyCtxRef.current.enabled
      ? sourceMarkdown?.trim() || rowsToMarkdownTable(tableRows(ref.current))
      : rowsToPlainText(tableRows(ref.current))
  return (
    <div className="md-table-outer">
      <div className="md-table-wrap">
        <table className="md-table" ref={ref} {...src}>
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
 *
 * Every override destructures `node` OUT (react-markdown passes the hast
 * node as a prop; spreading it onto a DOM element makes React warn) and
 * spreads the `...rest`, which is what carries rehypeSourceOffsets'
 * `data-s` / `data-e` through to the DOM. An override that destructures
 * only `{ children }` silently DROPS those attributes — and with them,
 * that element's contribution to a markdown copy.
 * ------------------------------------------------------------------ */
const markdownComponents: Components = {
  p: ({ node, className, children, ...rest }) => (
    <p className={cx('md-p', className)} {...rest}>
      {children}
    </p>
  ),
  // `title` is destructured out and dropped: `[label](url "T")` puts it in the property bag, and a
  // native title tooltip both lags ~1s and stacks on top of the data-tip this app replaced it with.
  a: ({ node, className, href, title, children, ...rest }) => (
    <a
      className={cx('md-a', className)}
      href={href}
      data-tip={href}
      data-tip-wide
      data-tip-compact
      onClick={(e) => {
        e.preventDefault()
        if (href) window.api.openExternal(href)
      }}
      // Right-click hands off to a NATIVE menu in main (Copy Link / Open Link in Browser). Suppressed
      // propagation so the click can't also reach the pane, and no menu at all without an href.
      onContextMenu={(e) => {
        if (!href) return
        e.preventDefault()
        e.stopPropagation()
        window.api.linkContextMenu(href)
      }}
      {...rest}
    >
      {children}
    </a>
  ),
  // Inline code is a bare <code>; fenced blocks render inside <pre>.
  // CSS distinguishes the two via `.md-code` vs `pre.md-pre .md-code`.
  // Merge the incoming className: rehype-highlight sets `hljs language-xxx` on fenced <code> plus the
  // token <span class="hljs-*"> children — clobbering className with a bare "md-code" would drop the
  // highlight hooks. The highlighted spans arrive as `children`, so rendering them as-is preserves them.
  // Inline math arrives as a `language-math math-inline` <code> carrying its own source offsets
  // (rehypeSourceOffsets can stamp it because remark-math preserves the node's position), so the
  // offsets forward straight onto the rendered formula and it stays one mapped copy unit.
  code: ({ node, className, children, ...rest }) => {
    if (classNamesOf(node).includes(MATH_INLINE)) {
      return <MathInline tex={texOf(node)} {...(rest as SrcAttrs)} />
    }
    return (
      <code className={cx('md-code', className)} {...rest}>
        {children}
      </code>
    )
  },
  // Display math is a <pre> wrapping a math <code>. The offsets live on the <pre> — descent stops
  // there — so this is the only place that can forward them, and it renders MathDisplay itself
  // rather than delegating to the <code> override (which would never see them).
  pre: ({ node, children, ...rest }) => {
    const tex = displayMathTex(node)
    if (tex !== null) return <MathDisplay tex={tex} {...(rest as SrcAttrs)} />
    return <CodeBlock {...rest}>{children}</CodeBlock>
  },
  ul: ({ node, className, children, ...rest }) => (
    <ul className={cx('md-ul', className)} {...rest}>
      {children}
    </ul>
  ),
  ol: ({ node, className, children, ...rest }) => (
    <ol className={cx('md-ol', className)} {...rest}>
      {children}
    </ol>
  ),
  li: ({ node, className, children, ...rest }) => (
    <li className={cx('md-li', className)} {...rest}>
      {children}
    </li>
  ),
  h1: ({ node, className, children, ...rest }) => (
    <h1 className={cx('md-h md-h1', className)} {...rest}>
      {children}
    </h1>
  ),
  h2: ({ node, className, children, ...rest }) => (
    <h2 className={cx('md-h md-h2', className)} {...rest}>
      {children}
    </h2>
  ),
  h3: ({ node, className, children, ...rest }) => (
    <h3 className={cx('md-h md-h3', className)} {...rest}>
      {children}
    </h3>
  ),
  h4: ({ node, className, children, ...rest }) => (
    <h4 className={cx('md-h md-h4', className)} {...rest}>
      {children}
    </h4>
  ),
  h5: ({ node, className, children, ...rest }) => (
    <h5 className={cx('md-h md-h5', className)} {...rest}>
      {children}
    </h5>
  ),
  h6: ({ node, className, children, ...rest }) => (
    <h6 className={cx('md-h md-h6', className)} {...rest}>
      {children}
    </h6>
  ),
  blockquote: ({ node, className, children, ...rest }) => (
    <blockquote className={cx('md-quote', className)} {...rest}>
      {children}
    </blockquote>
  ),
  // `style` carries the GFM column alignment (`text-align:…`) and always has — it is NOT part of the
  // property spread, so alignment behaves exactly as it did before the offsets were added.
  th: ({ node, className, children, style, ...rest }) => (
    <th className={cx('md-th', className)} style={style} {...rest}>
      {children}
    </th>
  ),
  td: ({ node, className, children, style, ...rest }) => (
    <td className={cx('md-td', className)} style={style} {...rest}>
      {children}
    </td>
  ),
  hr: ({ node, className, ...rest }) => <hr className={cx('md-hr', className)} {...rest} />,
  strong: ({ node, className, children, ...rest }) => (
    <strong className={cx('md-strong', className)} {...rest}>
      {children}
    </strong>
  ),
  em: ({ node, className, children, ...rest }) => (
    <em className={cx('md-em', className)} {...rest}>
      {children}
    </em>
  ),
  // An inline image's chip text ("🖼 alt") never matches its `![alt](url)` source, so it can't map
  // character-exactly — but keeping it ANNOTATED still pays: it becomes a bounded child, so the plain
  // text either side of it maps exactly instead of the whole paragraph widening.
  // Only the offsets are forwarded here: the element rendered is a <span>, and the property bag holds
  // an image's `src` / `title`, which are meaningless (and invalid) on one.
  img: ({ node, alt, ...rest }) => {
    const offsets = rest as SrcAttrs
    return (
      <span className="block-chip" data-s={offsets['data-s']} data-e={offsets['data-e']}>
        <span aria-hidden="true">🖼</span>
        <span>{alt && alt.trim() ? alt : 'image'}</span>
      </span>
    )
  }
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

function MarkdownBlock({
  text,
  blockKey,
  copyCtxRef
}: {
  text: string
  blockKey: string
  copyCtxRef: CopyCtxRef
}): ReactNode {
  // Override `table` with a closure over the source so its copy button yields the exact markdown
  // (cell formatting / alignment preserved) sliced via the node's position offsets — the same source
  // the turn copy uses. Everything else stays the shared module-level components.
  const components = useMemo<Components>(
    () => ({
      ...markdownComponents,
      table: ({ node, children, ...rest }) => (
        <TableBlock sourceMarkdown={sliceSource(text, node)} copyCtxRef={copyCtxRef} {...rest}>
          {children}
        </TableBlock>
      )
    }),
    // copyCtxRef is stable, so flipping the preference doesn't invalidate this — the table button
    // reads it when clicked instead.
    [text, copyCtxRef]
  )
  /* Math delimiters are normalised onto the form remark-math understands. The rewrite is
   * LENGTH-PRESERVING, which is what makes this a one-line change instead of a rework: every
   * source offset the parse produces still indexes `text`, so `sliceSource` above, the copy
   * pipeline, and the 0..length span below all keep using the ORIGINAL source — and a copied
   * formula comes back as the `\(…\)` the agent wrote, not the rewritten form. */
  const math = useMemo(() => normalizeMath(text), [text])
  const remarkPlugins = !math.hasMath
    ? remarkPlain
    : math.singleDollar
      ? remarkMathWithSingleDollar
      : remarkMathOnlyDoubleDollar

  // The wrapper is the copy handler's unit of work: `data-block-key` identifies which text block's
  // source to slice, and the 0..length span makes it the root of the same annotated tree its children
  // form — so one uniform walk describes the whole block (see lib/mdCopyDom.ts).
  return (
    <div className="md" data-block-key={blockKey} data-s={0} data-e={text.length}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {math.text}
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
 * wash) when isError, clamped to 6 lines with an Expand toggle.
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

function renderBlock(block: TranscriptBlock, key: string, copyCtxRef: CopyCtxRef): ReactNode {
  if (block.kind === 'text') {
    // `key` is `${message.uuid}:${blockIndex}` — reused as the copy handler's lookup into the source map.
    return <MarkdownBlock key={key} blockKey={key} text={block.text} copyCtxRef={copyCtxRef} />
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
  dividerBefore,
  copyCtxRef
}: {
  item: TranscriptItem
  dividerBefore: boolean
  /** TranscriptView's copy context (stable). The turn and table buttons read the preference from it
   *  when clicked, so toggling Preferences doesn't re-render every mounted block. */
  copyCtxRef: CopyCtxRef
}): ReactNode {
  const bodyRef = useRef<HTMLDivElement>(null)
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
  const proseMessages = item.items.flatMap((it) => (it.kind === 'turn' ? it.messages : []))
  const hasProse = proseMessages.some((m) => m.blocks.some((b) => b.kind === 'text'))

  /**
   * Copy-turn runs the SAME collector the ⌘C handler does, over a range covering this section's body —
   * so the button and a hand-drag across the same content cannot disagree. That matters now that tool
   * I/O is conditional on a run being expanded: a separate message-walking implementation would have no
   * way to see the DOM's disclosure state.
   */
  const turnText = (): string => {
    const body = bodyRef.current
    if (!body) return ''
    const sources = new Map<string, string>()
    for (const part of item.items) {
      if (part.kind !== 'turn') continue
      for (const msg of part.messages) {
        msg.blocks.forEach((b, bi) => {
          if (b.kind === 'text') sources.set(`${msg.uuid}:${bi}`, b.text)
        })
      }
    }
    const markdown = copyCtxRef.current.enabled
    const mode = markdown ? 'markdown' : 'plain'
    return assembleCopy(collectSections(rangeOver(body), body, (k) => sources.get(k), mode), false, !markdown)
  }

  return (
    <article className={classes} data-speaker={item.label} data-sidechain={item.isSidechain ? '' : undefined}>
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
        {hasProse ? <CopyButton className="copy-turn" tip="Copy turn" getText={turnText} /> : null}
        {time ? (
          <span className="message-time" data-tip={fullDateTime(ts)}>
            {time}
          </span>
        ) : null}
      </header>
      <div className="message-body" ref={bodyRef}>
        {item.items.map((it) =>
          it.kind === 'turn' ? (
            <div className="prose-beat" key={it.key}>
              {it.messages.flatMap((m) =>
                m.blocks.map((block, bi) => renderBlock(block, `${m.uuid}:${bi}`, copyCtxRef))
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
