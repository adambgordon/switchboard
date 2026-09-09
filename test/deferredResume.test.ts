import { describe, expect, it } from 'vitest'
import { deferredResumeAction } from '../src/renderer/lib/deferredResume'

describe('deferredResumeAction', () => {
  it('cancels as soon as the receiving tab disappears', () => {
    expect(deferredResumeAction(false, false)).toBe('cancel')
    expect(deferredResumeAction(false, true)).toBe('cancel')
  })

  it('waits only while the tab remains and metadata is missing', () => {
    expect(deferredResumeAction(true, false)).toBe('wait')
  })

  it('resumes once both the tab and metadata are present', () => {
    expect(deferredResumeAction(true, true)).toBe('resume')
  })
})
