import { describe, expect, it } from 'vitest'
import { viewToggleAction } from '../src/renderer/lib/viewToggle'

const cmdJ = {
  code: 'KeyJ',
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false
}

describe('viewToggleAction', () => {
  it('toggles a local live conversation in either direction', () => {
    expect(viewToggleAction(cmdJ, 'terminal', 'here')).toBe('transcript')
    expect(viewToggleAction(cmdJ, 'transcript', 'here')).toBe('terminal')
  })

  it('claims an existing remote terminal like the header button', () => {
    expect(viewToggleAction(cmdJ, 'transcript', 'claimable')).toBe('claim')
  })

  it('resumes a known conversation from Formatted view', () => {
    expect(viewToggleAction(cmdJ, 'transcript', 'resumable')).toBe('resume')
  })

  it('does not resume from a terminal surface', () => {
    expect(viewToggleAction(cmdJ, 'terminal', 'resumable')).toBeNull()
  })

  it('leaves an unavailable conversation unchanged', () => {
    expect(viewToggleAction(cmdJ, 'transcript', null)).toBeNull()
  })

  it('respects the disabled terminal control when another pane owns it', () => {
    expect(viewToggleAction(cmdJ, 'transcript', 'other-pane')).toBeNull()
  })

  it.each([
    ['plain J', { metaKey: false }],
    ['Ctrl+J', { metaKey: false, ctrlKey: true }],
    ['Cmd+Ctrl+J', { ctrlKey: true }],
    ['Cmd+Option+J', { altKey: true }],
    ['Cmd+Shift+J', { shiftKey: true }],
    ['a held shortcut', { repeat: true }],
    ['another Command shortcut', { code: 'KeyK' }]
  ])('leaves %s available without changing the view', (_name, changes) => {
    expect(viewToggleAction({ ...cmdJ, ...changes }, 'terminal', 'here')).toBeNull()
    expect(viewToggleAction({ ...cmdJ, ...changes }, 'transcript', 'claimable')).toBeNull()
    expect(viewToggleAction({ ...cmdJ, ...changes }, 'transcript', 'resumable')).toBeNull()
  })
})
