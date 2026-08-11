import { describe, expect, it } from 'vitest'
import { wireWindowFocus, type FocusableWindow } from '../src/main/windowFocus'

/** A stand-in for BrowserWindow: records listeners so a test can fire focus/blur at will. */
function fakeWindow(): FocusableWindow & {
  fire: (event: 'focus' | 'blur') => void
  destroyed: boolean
  attached: string[]
} {
  const listeners: Record<string, (() => void)[]> = { focus: [], blur: [] }
  return {
    destroyed: false,
    attached: [],
    on(event, listener) {
      listeners[event].push(listener)
      this.attached.push(event)
      return this
    },
    isDestroyed() {
      return this.destroyed
    },
    fire(event) {
      for (const l of listeners[event]) l()
    }
  }
}

function wired(): { win: ReturnType<typeof fakeWindow>; sent: boolean[] } {
  const win = fakeWindow()
  const sent: boolean[] = []
  wireWindowFocus(win, (f) => sent.push(f))
  return { win, sent }
}

describe('wireWindowFocus', () => {
  it('sends true on focus', () => {
    const { win, sent } = wired()
    win.fire('focus')
    expect(sent).toEqual([true])
  })

  it('sends false on blur', () => {
    const { win, sent } = wired()
    win.fire('blur')
    expect(sent).toEqual([false])
  })

  // Both directions in one sequence: a one-way signal (or an inverted one) leaves the renderer
  // stuck, which is the whole failure this module exists to prevent.
  it('reports every transition, in order', () => {
    const { win, sent } = wired()
    win.fire('focus')
    win.fire('blur')
    win.fire('focus')
    expect(sent).toEqual([true, false, true])
  })

  it('subscribes to both focus and blur', () => {
    const { win } = wired()
    expect(new Set(win.attached)).toEqual(new Set(['focus', 'blur']))
  })

  it('sends nothing until a transition happens', () => {
    const { sent } = wired()
    // The renderer seeds its own initial value over IPC; an eager send here would race that seed.
    expect(sent).toEqual([])
  })

  it('does not send once the window is destroyed', () => {
    const { win, sent } = wired()
    win.fire('focus')
    win.destroyed = true
    win.fire('blur')
    win.fire('focus')
    expect(sent).toEqual([true])
  })
})
