import { describe, expect, it } from 'vitest'
import { confirmedEmpty, endedStops, stopsOnClose } from '../src/renderer/lib/stopClose'

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

describe('confirmedEmpty', () => {
  it('is empty with no messages in the index and no transcript on disk', () => {
    expect(confirmedEmpty(0, null)).toBe(true)
  })

  it('is empty when the transcript exists but holds no messages', () => {
    expect(confirmedEmpty(0, { messages: [] })).toBe(true)
  })

  it('is not empty when the index already counts messages', () => {
    expect(confirmedEmpty(3, null)).toBe(false)
  })

  it('is not empty when the first message is on disk but not yet indexed', () => {
    // Ended within a second of the first message: the index still says 0.
    expect(confirmedEmpty(0, { messages: [{}] })).toBe(false)
  })
})

describe('stopsOnClose', () => {
  const running = { parkedJob: null, provisional: false, usedByUser: false }
  const unlinked = { parkedJob: null, provisional: true, usedByUser: false }

  it('stops a running terminal with nothing indexed — a new Claude session, or an unlinked Codex one', () => {
    expect(stopsOnClose(running, 0)).toBe(true)
    expect(stopsOnClose(unlinked, 0)).toBe(true)
  })

  it('stops a used terminal whose id is its own, since its transcript read can prove it empty', () => {
    expect(stopsOnClose({ ...running, usedByUser: true }, 0)).toBe(true)
  })

  it('leaves a used unlinked terminal running: its prompt may have started a rollout it is not bound to', () => {
    expect(stopsOnClose({ ...unlinked, usedByUser: true }, 0)).toBe(false)
  })

  it('leaves a conversation that has messages running', () => {
    expect(stopsOnClose(running, 1)).toBe(false)
  })

  it('has nothing to stop when no terminal is running', () => {
    expect(stopsOnClose(undefined, 0)).toBe(false)
  })

  it('leaves a terminal whose work went into a background agent running, though it looks empty', () => {
    expect(stopsOnClose({ ...running, parkedJob: { shortId: 'j1', name: 'Refactor the parser' } }, 0)).toBe(false)
  })
})
