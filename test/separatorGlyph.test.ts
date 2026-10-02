import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Metadata separators are a drawn dot, never the middle-dot glyph (see docs/design.md): flex rows
// use a `.sb-sep` element, one-line strings join with `META_SEP` and render through `MetaText`.
//
// The glyph is easy to reintroduce by hand, and it can reach the screen in several shapes: JSX
// text, a string or template literal, a CSS `content`. Rather than tell those apart from
// comments, the rule is blunter: the glyph appears nowhere under src/, comments included, except
// the lines listed here with a reason. Written as an escape it counts too.
const GLYPH = /·|\\u00b7|\\xb7|&middot;|&#183;|&#xb7;/i

// Keyed on file and a piece of the line, not a line number, so edits above an entry do not
// invalidate it. Each entry must match exactly once, so a stale one fails as well.
const ALLOWED = [
  { file: 'src/renderer/lib/format.ts', line: 'export const META_SEP', why: 'the one definition MetaText splits on' },
  {
    file: 'src/renderer/components/UpdatesSetting.tsx',
    line: 'sb-update-version',
    why: 'a version and a commit id are one identifier, not a list of details'
  }
]

// Resolved relative to THIS FILE rather than process.cwd(), so a different vitest working
// directory cannot make the test read no files and quietly pass.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(tsx?|css|html)$/.test(entry.name) ? [path] : []
  })
}

const files = sourceFiles(join(repo, 'src'))
const hits = files.flatMap((path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((text, i) =>
      GLYPH.test(text) ? [{ file: relative(repo, path), lineNo: i + 1, text: text.trim() }] : []
    )
)

describe('middle-dot separator glyph', () => {
  it('finds source files to check', () => {
    // Without this the scan could pass vacuously if src/ moved or the walk broke. The bound is
    // far below the current count so that removing files does not fail the suite.
    expect(files.length).toBeGreaterThan(50)
  })

  it('appears nowhere in src/ outside the allowed lines', () => {
    const offenders = hits
      .filter((h) => !ALLOWED.some((a) => a.file === h.file && h.text.includes(a.line)))
      .map((h) => `${h.file}:${h.lineNo}  ${h.text}`)
    expect(offenders).toEqual([])
  })

  it('matches each allowed line exactly once', () => {
    const counts = ALLOWED.map((a) => ({
      entry: `${a.file} "${a.line}"`,
      matches: hits.filter((h) => h.file === a.file && h.text.includes(a.line)).length
    }))
    expect(counts.filter((c) => c.matches !== 1)).toEqual([])
  })
})
