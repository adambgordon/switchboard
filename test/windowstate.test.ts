import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isOnScreen,
  resolvePlacement,
  loadWindowState,
  saveWindowState
} from '../src/main/windowState'

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 }
const DEFAULTS = { width: 1320, height: 860 }

describe('isOnScreen', () => {
  it('accepts a window fully inside a display', () => {
    expect(isOnScreen({ x: 100, y: 100, width: 800, height: 600 }, [DISPLAY])).toBe(true)
  })

  it('rejects a window fully off every display (monitor disconnected)', () => {
    expect(isOnScreen({ x: 4000, y: 2000, width: 800, height: 600 }, [DISPLAY])).toBe(false)
  })

  it('rejects when only a sliver overlaps, below the grab threshold', () => {
    // Just 20px of the window pokes back onto the display — under the 100px min.
    expect(isOnScreen({ x: 1900, y: 100, width: 800, height: 600 }, [DISPLAY])).toBe(false)
  })

  it('accepts a window living on a second display', () => {
    const right = { x: 1920, y: 0, width: 1920, height: 1080 }
    expect(isOnScreen({ x: 2000, y: 100, width: 800, height: 600 }, [DISPLAY, right])).toBe(true)
  })
})

describe('resolvePlacement', () => {
  it('returns defaults when nothing is saved', () => {
    expect(resolvePlacement(null, [DISPLAY], DEFAULTS)).toEqual(DEFAULTS)
  })

  it('keeps saved size + position when on-screen', () => {
    const saved = { x: 200, y: 150, width: 1000, height: 700 }
    expect(resolvePlacement(saved, [DISPLAY], DEFAULTS)).toEqual(saved)
  })

  it('keeps saved size but drops an off-screen position', () => {
    const saved = { x: 5000, y: 3000, width: 1000, height: 700 }
    expect(resolvePlacement(saved, [DISPLAY], DEFAULTS)).toEqual({ width: 1000, height: 700 })
  })

  it('keeps size when no position was saved', () => {
    expect(resolvePlacement({ width: 1000, height: 700 }, [DISPLAY], DEFAULTS)).toEqual({
      width: 1000,
      height: 700
    })
  })

  it('ignores the maximized/fullScreen flags — placement is geometry only', () => {
    const saved = { x: 200, y: 150, width: 1000, height: 700, maximized: true, fullScreen: true }
    expect(resolvePlacement(saved, [DISPLAY], DEFAULTS)).toEqual({
      x: 200,
      y: 150,
      width: 1000,
      height: 700
    })
  })
})

describe('load / save round-trip', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-winstate-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no file exists', () => {
    expect(loadWindowState(dir)).toBeNull()
  })

  it('round-trips saved bounds', () => {
    saveWindowState(dir, { x: 50, y: 60, width: 1100, height: 720 })
    expect(loadWindowState(dir)).toEqual({ x: 50, y: 60, width: 1100, height: 720 })
  })

  it('returns null on corrupt JSON', () => {
    writeFileSync(join(dir, 'window-state.json'), 'not json{')
    expect(loadWindowState(dir)).toBeNull()
  })

  it('drops x/y when only one coordinate is present', () => {
    writeFileSync(join(dir, 'window-state.json'), JSON.stringify({ x: 10, width: 800, height: 600 }))
    expect(loadWindowState(dir)).toEqual({ width: 800, height: 600 })
  })

  it('round-trips the maximized flag', () => {
    saveWindowState(dir, { x: 10, y: 20, width: 1000, height: 700, maximized: true })
    expect(loadWindowState(dir)).toEqual({ x: 10, y: 20, width: 1000, height: 700, maximized: true })
  })

  it('round-trips the fullScreen flag', () => {
    saveWindowState(dir, { width: 1000, height: 700, fullScreen: true })
    expect(loadWindowState(dir)).toEqual({ width: 1000, height: 700, fullScreen: true })
  })

  it('omits false flags from the persisted file', () => {
    saveWindowState(dir, { x: 1, y: 2, width: 800, height: 600, maximized: false, fullScreen: false })
    expect(loadWindowState(dir)).toEqual({ x: 1, y: 2, width: 800, height: 600 })
  })

  it('ignores a non-boolean maximized value on load', () => {
    writeFileSync(
      join(dir, 'window-state.json'),
      JSON.stringify({ width: 800, height: 600, maximized: 'yes' })
    )
    expect(loadWindowState(dir)).toEqual({ width: 800, height: 600 })
  })
})
