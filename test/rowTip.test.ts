import { describe, expect, it } from 'vitest'
import {
  TIP_META_MAX,
  TIP_PREVIEW_MAX,
  TIP_TITLE_MAX,
  rowTipMeta,
  rowTipPreview,
  rowTipTitle,
  tipPlace
} from '../src/renderer/lib/rowTip'

describe('tipPlace', () => {
  it('says nothing at the project root', () => {
    expect(tipPlace('/w/app', '/w/app')).toBe('')
  })

  it('gives the path below the root for a subdirectory, not just its last segment', () => {
    expect(tipPlace('/w/app/src/renderer', '/w/app')).toBe('src/renderer')
  })

  it('names a directory outside the root — a linked worktree — by its own name', () => {
    expect(tipPlace('/w/trees/app/fix-scroll', '/w/app')).toBe('fix-scroll')
  })

  it('does not mistake a sibling sharing the root as a prefix for a subdirectory', () => {
    // A bare `startsWith(root)` reads `/w/app-two` as `-two` under `/w/app`.
    expect(tipPlace('/w/app-two', '/w/app')).toBe('app-two')
  })

  it('handles the filesystem root as a project root', () => {
    expect(tipPlace('/scratch/notes', '/')).toBe('scratch/notes')
  })
})

describe('rowTipMeta', () => {
  const NONE = { background: false, elsewhere: false }

  it('joins the folder label and the place within it', () => {
    expect(rowTipMeta('app', '/w/trees/app/fix-scroll', '/w/app', NONE)).toBe('app · fix-scroll')
  })

  it('is just the label at the project root', () => {
    expect(rowTipMeta('app', '/w/app', '/w/app', NONE)).toBe('app')
  })

  it('names the row markers after the place, each only when it applies', () => {
    expect(rowTipMeta('app', '/w/app/src', '/w/app', { background: false, elsewhere: true })).toBe(
      'app · src · In another window'
    )
    expect(rowTipMeta('app', '/w/app', '/w/app', { background: true, elsewhere: false })).toBe(
      'app · Background session'
    )
    expect(rowTipMeta('app', '/w/app', '/w/app', { background: true, elsewhere: true })).toBe(
      'app · Background session · In another window'
    )
  })

  it('is end-clamped to its budget', () => {
    const out = rowTipMeta('app', `/w/app/${'d'.repeat(400)}`, '/w/app', NONE)
    expect(Array.from(out)).toHaveLength(TIP_META_MAX)
    expect(out.startsWith('app · ddd')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('rowTipTitle / rowTipPreview', () => {
  it('keeps the START of a long title and preview — they are prose, read from the start', () => {
    const title = `Opening words ${'x'.repeat(500)} closing words`
    const t = rowTipTitle(title)
    expect(Array.from(t)).toHaveLength(TIP_TITLE_MAX)
    expect(t.startsWith('Opening words')).toBe(true)
    expect(t).not.toContain('closing')
    const p = rowTipPreview(title)!
    expect(Array.from(p)).toHaveLength(TIP_PREVIEW_MAX)
    expect(p.startsWith('Opening words')).toBe(true)
  })

  it('omits an absent preview rather than sending an empty line', () => {
    expect(rowTipPreview('')).toBeNull()
    expect(rowTipPreview(null)).toBeNull()
  })

  it('leaves short fields untouched', () => {
    expect(rowTipTitle('Fix the drag')).toBe('Fix the drag')
    expect(rowTipPreview('Looks good')).toBe('Looks good')
  })
})
