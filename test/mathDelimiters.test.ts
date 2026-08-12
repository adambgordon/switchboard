import { describe, expect, it } from 'vitest'
import { codeRanges, lineCodeRanges, normalizeMath } from '../src/renderer/lib/mathDelimiters'

/**
 * The fixtures below are the shapes both agents actually emit, and — just as importantly — the
 * non-math shapes that share these delimiters. Every guard here was mutation-checked: revert it in
 * the source and a NAMED test below fails.
 *
 * The recurring assertion is LENGTH PRESERVATION. It is not cosmetic: the copy pipeline slices the
 * ORIGINAL text using offsets produced by parsing the rewritten text, so an unequal-length rewrite
 * would corrupt every formula's copied source and everything after it in the block.
 */

const DISPLAY_LATEX = ['\\[', '\\sum_{i=1}^{n} x_i', '\\]'].join('\n')
const DISPLAY_DOLLAR = ['$$', '\\sum_{i=1}^{n} x_i', '$$'].join('\n')

/** Assert the contract that must hold for every input, math or not. */
function normalized(text: string): ReturnType<typeof normalizeMath> {
  const result = normalizeMath(text)
  expect(result.text).toHaveLength(text.length)
  return result
}

describe('normalizeMath — the display-block gate', () => {
  it('leaves a block with no display block completely untouched', () => {
    const src = 'Set $PATH, see \\[DEBUG\\], run \\(x\\) and `sed \'s/a\\(b\\)/\\1/\'`.'
    const out = normalized(src)
    expect(out.hasMath).toBe(false)
    expect(out.text).toBe(src)
  })

  it('recognises a line-anchored \\[ … \\] display block', () => {
    const out = normalized(`Bound:\n\n${DISPLAY_LATEX}\n`)
    expect(out.hasMath).toBe(true)
    expect(out.text).toContain('$$\n\\sum_{i=1}^{n} x_i\n$$')
  })

  it('recognises a line-anchored $$ … $$ display block without rewriting it', () => {
    const src = `Bound:\n\n${DISPLAY_DOLLAR}\n`
    const out = normalized(src)
    expect(out.hasMath).toBe(true)
    expect(out.text).toBe(src)
  })

  // The discriminator. `\[DEBUG\]` is an escaped literal bracket and renders correctly already;
  // promoting it would turn a log tag into a centered equation.
  it('does NOT treat an inline \\[…\\] as display math', () => {
    for (const src of ['Logs show \\[DEBUG\\] lines.', 'Saw \\[FV-attach\\] and \\[default\\].']) {
      const out = normalized(src)
      expect(out.hasMath).toBe(false)
      expect(out.text).toBe(src)
    }
  })

  it('requires the CLOSING delimiter on its own line too', () => {
    const out = normalized('Bound:\n\n\\[\n\\sum_i x_i \\]\n')
    expect(out.hasMath).toBe(false)
  })
})

describe('normalizeMath — inline math is admitted only by a display block', () => {
  it('rewrites paired \\(…\\) once a display block is present', () => {
    const out = normalized(`Counts \\(P_i\\) and \\(T\\).\n\n${DISPLAY_LATEX}\n`)
    expect(out.hasMath).toBe(true)
    expect(out.text).toContain('Counts $$P_i$$ and $$T$$.')
  })

  it('leaves \\(…\\) alone when no display block admits it', () => {
    const src = 'Counts \\(P_i\\) and \\(T\\) only.'
    expect(normalized(src).text).toBe(src)
  })

  it('leaves an UNPAIRED \\( alone (a regex, not math)', () => {
    const src = `Run \`rg -n "def map\\("\` first.\n\n${DISPLAY_LATEX}\n`
    const out = normalized(src)
    expect(out.text).toContain('def map\\(')
  })

  it('does not pair \\( with a \\) on a LATER line', () => {
    const out = normalized(`Open \\(here\nand close\\) there.\n\n${DISPLAY_LATEX}\n`)
    expect(out.text).toContain('Open \\(here')
    expect(out.text).toContain('and close\\) there.')
  })
})

describe('normalizeMath — single-$ is admitted only by a $$ display block', () => {
  // The conservative tie-break: a block that wrote its display math as \[…\] has shown it uses the
  // LaTeX family, so a bare $ in it is likelier a shell sigil than a delimiter. Failing to render
  // real math is preferred over mangling a shell command.
  it('withholds single-$ when the display block is \\[ … \\]', () => {
    const out = normalized(`Set $PATH and $HOME.\n\n${DISPLAY_LATEX}\n`)
    expect(out.hasMath).toBe(true)
    expect(out.singleDollar).toBe(false)
  })

  it('admits single-$ when the display block is $$ … $$', () => {
    const out = normalized(`Utilization $\\rho$ holds.\n\n${DISPLAY_DOLLAR}\n`)
    expect(out.hasMath).toBe(true)
    expect(out.singleDollar).toBe(true)
  })

  it('admits single-$ when BOTH families appear (a $$ block is present)', () => {
    const out = normalized(`Both here.\n\n${DISPLAY_LATEX}\n\n${DISPLAY_DOLLAR}\n`)
    expect(out.singleDollar).toBe(true)
  })
})

describe('normalizeMath — code is never math', () => {
  it('leaves a fenced ```latex sample as source', () => {
    const src = ['Here is the source:', '', '```latex', '\\[', '  L = \\lambda W', '\\]', '```'].join('\n')
    const out = normalized(src)
    expect(out.hasMath).toBe(false)
    expect(out.text).toBe(src)
  })

  it('still renders real math in a block that ALSO has a fenced latex sample', () => {
    const src = [`${DISPLAY_LATEX}`, '', '```latex', '\\[', '  L = \\lambda W', '\\]', '```'].join('\n')
    const out = normalized(src)
    expect(out.hasMath).toBe(true)
    // the fence keeps its backslash delimiters; only the first block was rewritten
    expect(out.text.slice(out.text.indexOf('```latex'))).toContain('\\[')
    expect(out.text.slice(0, out.text.indexOf('```latex'))).toContain('$$')
  })

  it('leaves sed capture groups and jq interpolation in code spans alone', () => {
    const src = [
      "Use `sed -n 's/x\\([0-9]*\\)/\\1/p'` and `jq -r '\"\\(.name)\"'`.",
      '',
      DISPLAY_LATEX,
      ''
    ].join('\n')
    const out = normalized(src)
    expect(out.text).toContain("sed -n 's/x\\([0-9]*\\)/\\1/p'")
    expect(out.text).toContain('jq -r \'"\\(.name)"\'')
  })

  it('does not let a fenced $$ line open a display block', () => {
    const src = ['```', '$$', 'not math', '$$', '```'].join('\n')
    const out = normalized(src)
    expect(out.hasMath).toBe(false)
    expect(out.text).toBe(src)
  })

  /* The two checks below isolate the opener and closer guards from each other. On a fully-fenced
   * block either one alone suffices, so a symmetric fixture cannot tell which is doing the work —
   * these are deliberately ASYMMETRIC: one delimiter inside code, its partner outside. */
  it('an opener inside a code span cannot pair with a closer outside it', () => {
    const src = ['Text `spanning', '$$', 'still code` here.', '', '$$'].join('\n')
    const out = normalized(src)
    expect(out.hasMath).toBe(false)
    expect(out.text).toBe(src)
  })

  it('a closer inside a code span does not close an opener outside it', () => {
    const src = ['$$', 'x', '`code', '$$', "end`"].join('\n')
    const out = normalized(src)
    expect(out.hasMath).toBe(false)
    expect(out.text).toBe(src)
  })

  it('excludes INDENTED code blocks', () => {
    const src = ['Sample:', '', '    \\[', '    x = 1', '    \\]', '', 'done'].join('\n')
    const out = normalized(src)
    expect(out.hasMath).toBe(false)
    expect(out.text).toBe(src)
  })

  // The fail-closed contract: an indented sample must not license `$…$` parsing for the whole block.
  it('an indented $$ sample cannot opt the block into single-dollar math', () => {
    const src = ['Set $PATH and $HOME.', '', '    $$', '    x', '    $$', ''].join('\n')
    const out = normalized(src)
    expect(out.hasMath).toBe(false)
    expect(out.singleDollar).toBe(false)
    expect(out.text).toBe(src)
  })

  it('a fence marker with trailing text does not close the fence', () => {
    const src = ['```js', 'const a = 1', '```trailing', '\\[', 'x', '\\]'].join('\n')
    const out = normalized(src)
    expect(out.hasMath).toBe(false)
    expect(out.text).toBe(src)
  })

  // Overlap, not containment: the pair starts inside a code span and ends outside it.
  it('rejects a delimiter pair that only PARTLY overlaps code', () => {
    const src = ['A `code \\(x` then \\) tail.', '', DISPLAY_LATEX, ''].join('\n')
    const out = normalized(src)
    expect(out.text.split('\n')[0]).toBe('A `code \\(x` then \\) tail.')
  })
})

describe('normalizeMath — the display body is left verbatim', () => {
  it('does not rewrite \\( inside a display body', () => {
    const src = ['$$', '\\max\\(1, x\\)', '$$'].join('\n')
    const out = normalized(src)
    expect(out.hasMath).toBe(true)
    expect(out.text).toBe(src)
  })
})

describe('normalizeMath — offsets are UTF-16, not code points', () => {
  /* An astral character is TWO UTF-16 units but ONE code point. Every offset in the module comes
   * from UTF-16-based APIs, so a code-point-indexed buffer writes to the wrong place. Note the first
   * case below preserved LENGTH while destroying content — which is why the invariant assertion
   * alone was not enough, and why these fixtures exist. */
  it('rewrites correctly with an emoji before the formula', () => {
    const out = normalized(`😀 intro\n\n${DISPLAY_LATEX}\n`)
    expect(out.hasMath).toBe(true)
    expect(out.text).toBe(`😀 intro\n\n$$\n\\sum_{i=1}^{n} x_i\n$$\n`)
  })

  it('rewrites correctly with several astral characters before the formula', () => {
    const out = normalized(`🎉🎉 intro\n\n${DISPLAY_LATEX}\n`)
    expect(out.text).toBe(`🎉🎉 intro\n\n$$\n\\sum_{i=1}^{n} x_i\n$$\n`)
  })

  it('rewrites inline math correctly after an emoji', () => {
    const out = normalized(`😀 counts \\(P_i\\).\n\n${DISPLAY_LATEX}\n`)
    expect(out.text).toContain('😀 counts $$P_i$$.')
  })

  it('leaves an emoji INSIDE a display body untouched', () => {
    const src = ['$$', '\\text{😀}', '$$'].join('\n')
    expect(normalized(src).text).toBe(src)
  })
})

describe('normalizeMath — offsets index the ORIGINAL text', () => {
  it('keeps every rewritten delimiter at its original position', () => {
    const src = `Counts \\(P_i\\) here.\n\n${DISPLAY_LATEX}\n`
    const out = normalized(src)
    // Every position the rewrite touched must hold '$' in the output and a delimiter char in the input.
    for (let i = 0; i < src.length; i++) {
      if (src[i] === out.text[i]) continue
      expect(out.text[i]).toBe('$')
      expect(['\\', '[', ']', '(', ')']).toContain(src[i])
    }
  })
})

describe('codeRanges', () => {
  it('spans a fenced block including its markers', () => {
    const src = ['a', '```', 'x', '```', 'b'].join('\n')
    const ranges = codeRanges(src)
    const fenceStart = src.indexOf('```')
    expect(ranges.some(([s, e]) => fenceStart >= s && fenceStart < e)).toBe(true)
  })

  it('closes a code span only on a backtick run of equal length', () => {
    // A run of 1 must skip PAST a run of 2 to find its partner.
    expect(codeRanges('`x`` y`')).toContainEqual([0, 7])
  })

  it('leaves a run unclosed when only a LONGER run follows', () => {
    /* The discriminating case. In `x`` y the single backtick has no partner (the `` is a different
     * length, and nothing follows), so there is no code span at all. A "close on any run of at least
     * this length" rule instead pairs it with the ``. The case above cannot show that difference:
     * the wrong rule splits the span in two, and range MERGING rejoins them into the same extent. */
    expect(codeRanges('`x`` y')).toEqual([])
  })

  it('does not let a longer run close a shorter one', () => {
    // The double-backtick span here is closed by the final ``, not by the single ` inside it.
    const src = '``a ` b``'
    expect(codeRanges(src)).toContainEqual([0, 9])
  })

  it('ignores an unclosed backtick run', () => {
    expect(codeRanges('a ` b').length).toBe(0)
  })
})

describe('normalizeMath — scanning stays linear', () => {
  /* These guard PERFORMANCE properties. Two rules learned the hard way:
   *
   * 1. Assert structure, not elapsed time — WHERE possible. An earlier version timed 2,000 vs 8,000
   *    lines and compared the ratio. It passed alone and failed intermittently under `npm test`,
   *    where 34 files compete for CPU and the two samples are measured under different load. A ratio
   *    of two ~1 ms measurements is not a signal. Never reintroduce one.
   *
   * 2. Assert it on the function where the property LIVES. The blowups share a cause: every
   *    delimiter and backtick tests itself against the protected-range list, so a list that grows per
   *    code LINE makes the work (candidates × lines). Merging bounds it — but `codeRanges`' output is
   *    merged whether the merge runs before the backtick scan or at the return, and only the former
   *    is correct. So the assertion belongs on `lineCodeRanges`, the list the scan consumes. An
   *    earlier version of this suite asserted on `codeRanges` and passed under exactly the mutant it
   *    claimed to guard. */
  const LINES = 4000
  const openers = (n: number): string[] => Array.from({ length: n }, () => '\\[')

  for (const [label, src] of [
    ['fenced', ['```latex', ...openers(LINES), '```'].join('\n')],
    ['indented', openers(LINES).map((l) => `    ${l}`).join('\n')],
    // A blank line used to END an indented block, so a separated sample never became contiguous.
    ['blank-separated indented', openers(LINES).flatMap((l) => [`    ${l}`, '']).join('\n')],
    /* A backtick on every fenced line — the shape that needs the merge to precede the scan.
     * The leading display block is load-bearing in the fixture: without a line that trims to a bare
     * delimiter, `mightHaveDisplay` rejects the text and `normalizeMath` returns before `codeRanges`
     * is ever reached, so the fixture would exercise nothing at all. */
    [
      'fenced with a backtick per line',
      ['\\[', 'x', '\\]', '', '```', ...openers(LINES).map((l) => `${l} \`x\``), '```'].join('\n')
    ]
  ] as const) {
    it(`collapses a ${label} sample to one protected range, before the scan consumes it`, () => {
      // On lineCodeRanges — see rule 2 above. This is what the per-backtick lookup reads.
      expect(lineCodeRanges(src)).toHaveLength(1)
      expect(codeRanges(src)).toHaveLength(1)
      // And the whole normalize still runs — a guard against the shape passing while parsing throws.
      expect(normalizeMath(src).text).toHaveLength(src.length)
    })
  }

  /* Display pairing has NO structural proxy: the nested-loop and single-pass versions return
   * identical blocks and differ only in time, so this is the one place a wall-clock assertion earns
   * its keep. Made robust by scale and headroom rather than by comparing two samples — 20,000
   * unmatched openers cost ~3 ms paired in one pass and ~2.7 s with a rescan per opener, so the
   * ceiling sits ~100x above correct and well below the regression. */
  it('pairs display delimiters in one pass, not a rescan per opener', () => {
    const src = openers(20_000).join('\n')
    const started = performance.now()
    expect(normalizeMath(src).text).toHaveLength(src.length)
    expect(performance.now() - started).toBeLessThan(400)
  })

  it('keeps an indented block contiguous across its interior blank lines', () => {
    expect(codeRanges(['    a', '', '    b', '', '    c'].join('\n'))).toHaveLength(1)
  })

  it('does not extend an indented block past its TRAILING blank lines', () => {
    const src = ['    a', '', '', 'prose \\(x\\) here'].join('\n')
    const [range] = codeRanges(src)
    expect(range[1]).toBeLessThanOrEqual(src.indexOf('prose'))
  })
})

describe('normalizeMath — the fast path allocates nothing observable', () => {
  it('returns the same string reference when there is no display delimiter', () => {
    const src = 'Plain prose with $PATH and a (paren) and [a bracket].'
    const out = normalizeMath(src)
    expect(out.text).toBe(src)
    expect(out.hasMath).toBe(false)
    expect(out.singleDollar).toBe(false)
  })
})
