import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
// KaTeX's stylesheet is imported eagerly while the ENGINE below is not. It is small, and having it
// present before the engine resolves means a formula never flashes unstyled. The `@font-face` rules
// it carries do not fetch anything until a glyph actually needs them, so a transcript with no math
// costs the stylesheet text and no font bytes.
import 'katex/dist/katex.min.css'

/** The offsets `rehypeSourceOffsets` stamps, forwarded so a formula stays a mapped copy unit. */
type SrcAttrs = { 'data-s'?: number | string; 'data-e'?: number | string }

/** Narrowed to the one call used, rather than `typeof import('katex')` — that type carries the
 *  UMD build's self-reference, which the ES module's default export does not have. */
type KatexEngine = {
  renderToString: (tex: string, options?: import('katex').KatexOptions) => string
}

/* ------------------------------------------------------------------ *
 * Lazy engine.
 *
 * KaTeX's parser is by far the largest thing this view could pull in, and math appears in a tiny
 * fraction of conversations — so it is NOT in the startup bundle. It is fetched the first time a
 * formula mounts, once per session, and every waiting formula re-renders when it lands. Until then
 * (and forever, if the import fails) the LaTeX source stands in, which is what the view showed
 * before math was supported — so the degraded state is the old state, not a blank.
 * ------------------------------------------------------------------ */
let engine: KatexEngine | null = null
let pending: Promise<void> | null = null
const waiting = new Set<() => void>()

function loadEngine(): void {
  if (engine || pending) return
  pending = import('katex')
    .then((mod) => {
      engine = mod.default ?? mod
    })
    .catch(() => {
      // Swallowed on purpose: `engine` stays null and every formula keeps showing its source.
    })
    .finally(() => {
      pending = null
      for (const notify of waiting) notify()
    })
}

function useKatex(): KatexEngine | null {
  const [, bump] = useState(0)
  useEffect(() => {
    if (engine) return
    const notify = (): void => bump((n) => n + 1)
    waiting.add(notify)
    loadEngine()
    return () => {
      waiting.delete(notify)
    }
  }, [])
  return engine
}

/**
 * Render one formula to HTML, or null when it cannot be rendered.
 *
 * `throwOnError` is deliberately TRUE even though KaTeX offers a lenient mode: that mode is
 * inconsistent — it marks some failures with its own error styling and silently mis-renders
 * others — and its error red would fight the transcript's use of red for genuine errors. Catching
 * instead gives one predictable outcome for every failure: show the source.
 *
 * `output: 'html'` drops KaTeX's parallel MathML tree. That halves the node count, and it leaves
 * the formula with a SINGLE text representation — the default emits both, so `textContent` reads
 * the formula three times over, which would corrupt the copy pipeline's offset walk.
 */
function render(katex: KatexEngine | null, tex: string, displayMode: boolean): string | null {
  if (!katex) return null
  try {
    return katex.renderToString(tex, { output: 'html', displayMode, throwOnError: true })
  } catch {
    return null
  }
}

/* KaTeX builds this markup itself from the LaTeX source and, with `trust` left at its default,
 * refuses the commands that could inject anything — so the HTML is generated, never passed
 * through from the transcript. */
const html = (markup: string): { __html: string } => ({ __html: markup })

/** Inline math — sits in the text flow, so it must not introduce a line box of its own. */
export function MathInline({ tex, ...src }: { tex: string } & SrcAttrs): ReactNode {
  const katex = useKatex()
  const markup = useMemo(() => render(katex, tex, false), [katex, tex])
  if (markup === null) {
    return (
      <code className="md-math-src" {...src}>
        {tex}
      </code>
    )
  }
  return <span className="md-math" {...src} dangerouslySetInnerHTML={html(markup)} />
}

/**
 * Display math — its own centered block.
 *
 * Rendered as a `<div>`, not a `<pre>`: the copy pipeline treats a `<pre>` as a fenced unit with
 * its own widening rule, whereas a formula should behave like the inline-image chip — a bounded
 * annotated node whose rendered text never matches its source, so a selection touching it yields
 * the whole original `\[…\]`.
 */
export function MathDisplay({ tex, ...src }: { tex: string } & SrcAttrs): ReactNode {
  const katex = useKatex()
  const markup = useMemo(() => render(katex, tex, true), [katex, tex])
  if (markup === null) {
    return (
      <div className="md-math-display is-src" {...src}>
        <pre className="md-math-src-block">{tex}</pre>
      </div>
    )
  }
  return <div className="md-math-display" {...src} dangerouslySetInnerHTML={html(markup)} />
}
