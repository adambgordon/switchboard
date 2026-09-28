import { describe, expect, it } from 'vitest'
import { emptyAfterStop, endedStops } from '../src/renderer/lib/stopClose'

describe('endedStops', () => {
  it('names the stopped conversations whose terminals are gone, and only those', () => {
    const stopped = new Set(['a', 'b', 'c'])
    const live = new Map([['b', {}], ['z', {}]])
    expect(endedStops(stopped, live)).toEqual(['a', 'c'])
  })

  it('names none while every stopped terminal is still exiting', () => {
    expect(endedStops(new Set(['a']), new Map([['a', {}]]))).toEqual([])
  })

  it('ignores a terminal that exited without being stopped', () => {
    expect(endedStops(new Set(), new Map())).toEqual([])
  })
})

describe('emptyAfterStop', () => {
  it('closes a conversation with no messages in the index and no transcript on disk', () => {
    expect(emptyAfterStop(0, null)).toBe(true)
  })

  it('closes one whose transcript exists but holds no messages', () => {
    expect(emptyAfterStop(0, { messages: [] })).toBe(true)
  })

  it('keeps one the index already counts messages for', () => {
    expect(emptyAfterStop(3, null)).toBe(false)
  })

  it('keeps one whose first message is on disk but not yet indexed', () => {
    // Stopped within a second of the first message: the index still says 0.
    expect(emptyAfterStop(0, { messages: [{}] })).toBe(false)
  })
})
