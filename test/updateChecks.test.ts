import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateChecks } from '../src/main/updateChecks'
import type { UpdateCheck, UpdateCheckState } from '../src/shared/types'

const INTERVAL = 30 * 60 * 1000
const flush = () => vi.advanceTimersByTimeAsync(0)

function harness(options: { intervalMs?: number; periodic?: boolean } = {}) {
  const pending: Array<{ resolve: (result: UpdateCheck) => void; reject: (error: Error) => void }> = []
  const states: UpdateCheckState[] = []
  const checks = new UpdateChecks(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    (state) => states.push(state),
    options
  )
  const finish = async (index: number, result: UpdateCheck = { status: 'current' }) => {
    expect(pending[index], `lookup ${index} must have started`).toBeDefined()
    pending[index].resolve(result)
    await flush()
  }
  return { checks, pending, states, finish }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('UpdateChecks', () => {
  it('checks once at startup and again at the exact 30-minute deadline', async () => {
    const h = harness()
    h.checks.start(); h.checks.start(); await flush()
    expect(h.pending).toHaveLength(1)
    expect(h.checks.state).toEqual({ check: null, checking: true })
    await h.finish(0)
    expect(h.states).toEqual([
      { check: null, checking: true }, { check: { status: 'current' }, checking: false }
    ])
    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(h.pending).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.pending).toHaveLength(2)
    expect(h.checks.state).toEqual({ check: { status: 'current' }, checking: true })
    await h.finish(1, { status: 'behind' })
    expect(h.checks.state).toEqual({ check: { status: 'behind' }, checking: false })
    expect(vi.getTimerCount()).toBe(1)
  })

  it('measures the interval from completion and honors an injected interval', async () => {
    const h = harness({ intervalMs: 700 })
    h.checks.start(); await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.pending).toHaveLength(1)
    await h.finish(0)
    await vi.advanceTimersByTimeAsync(699)
    expect(h.pending).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.pending).toHaveLength(2)
  })

  it('serves cached reads without resetting the deadline; a fresh manual check resets it', async () => {
    const h = harness()
    h.checks.start(); await flush(); await h.finish(0)
    await vi.advanceTimersByTimeAsync(INTERVAL / 2)
    await expect(h.checks.check()).resolves.toEqual({ status: 'current' })
    expect(h.pending).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(INTERVAL / 2)
    expect(h.pending).toHaveLength(2)
    await h.finish(1)
    await vi.advanceTimersByTimeAsync(1000)
    const manual = h.checks.check(true)
    await flush(); await h.finish(2, { status: 'behind' }); await manual
    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(h.pending).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.pending).toHaveLength(4)
  })

  it('coalesces startup and manual requests, including from multiple windows', async () => {
    const h = harness()
    h.checks.start()
    const first = h.checks.check()
    const second = h.checks.check(true)
    expect(second).toBe(first)
    await flush()
    expect(h.pending).toHaveLength(1)
    await h.finish(0)
    await expect(first).resolves.toEqual({ status: 'current' })
    expect(vi.getTimerCount()).toBe(1)
  })

  it('retains the displayed result after background failure and retries at the normal interval', async () => {
    const h = harness()
    h.checks.start(); await flush(); await h.finish(0, { status: 'behind' })
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await h.finish(1, { status: 'unknown', reason: 'offline' })
    expect(h.checks.state).toEqual({ check: { status: 'behind' }, checking: false })
    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(h.pending).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.pending).toHaveLength(3)
    await h.finish(2)
    expect(h.checks.state.check).toEqual({ status: 'current' })
  })

  it('shows initial failure and preserves explicit failure feedback, including a joined background check', async () => {
    const h = harness()
    h.checks.start(); await flush(); await h.finish(0, { status: 'unknown', reason: 'offline' })
    expect(h.checks.state.check).toEqual({ status: 'unknown', reason: 'offline' })
    const manual = h.checks.check(true)
    await flush(); await h.finish(1, { status: 'behind' }); await manual
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const joined = h.checks.check(true)
    await h.finish(2, { status: 'unknown', reason: 'timed out' })
    await expect(joined).resolves.toEqual({ status: 'unknown', reason: 'timed out' })
    expect(h.pending).toHaveLength(3)
    expect(h.checks.state).toEqual({ check: { status: 'unknown', reason: 'timed out' }, checking: false })
  })

  it('converts a rejected lookup into a settled result and remains retryable', async () => {
    const h = harness()
    const first = h.checks.check(true)
    await flush(); h.pending[0].reject(new Error('network failed')); await flush()
    await expect(first).resolves.toEqual({ status: 'unknown', reason: 'network failed' })
    expect(h.checks.state.checking).toBe(false)
    const retry = h.checks.check(true)
    await flush(); await h.finish(1); await retry
    expect(h.checks.state.check).toEqual({ status: 'current' })
  })

  it('keeps a recent deadline on wake and coalesces one overdue check after a long sleep', async () => {
    const h = harness()
    h.checks.start(); await flush(); await h.finish(0)
    await vi.advanceTimersByTimeAsync(INTERVAL - 100)
    h.checks.wake(); await flush()
    expect(h.pending).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    h.checks.wake(); h.checks.wake(); await flush()
    expect(h.pending).toHaveLength(2)
    await h.finish(1)
    vi.setSystemTime(Date.now() + 5 * INTERVAL)
    h.checks.wake(); h.checks.wake(); await flush()
    expect(h.pending).toHaveLength(3)
    await h.finish(2)
    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(h.pending).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.pending).toHaveLength(4)
  })

  it('pauses all checks and resumes one full interval after an update failure', async () => {
    const h = harness()
    h.checks.start(); await flush(); await h.finish(0, { status: 'behind' })
    h.checks.setPaused(true)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(3 * INTERVAL)
    h.checks.wake()
    await expect(h.checks.check(true)).resolves.toEqual({ status: 'behind' })
    expect(h.pending).toHaveLength(1)
    expect(h.states).toHaveLength(2)
    h.checks.setPaused(false)
    await vi.advanceTimersByTimeAsync(INTERVAL / 2)
    h.checks.setPaused(false)
    await vi.advanceTimersByTimeAsync(INTERVAL / 2 - 1)
    expect(h.pending).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.pending).toHaveLength(2)
  })

  it('does not schedule when an existing check finishes during an update', async () => {
    const h = harness()
    h.checks.start(); await flush()
    h.checks.setPaused(true)
    await h.finish(0)
    expect(h.checks.state.checking).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(h.pending).toHaveLength(1)
    expect(h.states).toHaveLength(2)
    h.checks.setPaused(false)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(h.pending).toHaveLength(2)
  })

  it('keeps startup and explicit checks available when periodic scheduling is disabled', async () => {
    const h = harness({ periodic: false })
    h.checks.start(); await flush(); await h.finish(0)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(INTERVAL * 5)
    h.checks.wake(); await flush()
    expect(h.pending).toHaveLength(1)
    const manual = h.checks.check(true)
    await flush(); await h.finish(1); await manual
    expect(h.pending).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disposes the timer and prevents future checks', async () => {
    const h = harness()
    h.checks.start(); await flush(); await h.finish(0)
    h.checks.dispose()
    expect(vi.getTimerCount()).toBe(0)
    h.checks.start(); h.checks.wake(); h.checks.setPaused(false)
    await h.checks.check(true)
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(h.pending).toHaveLength(1)
  })

  it('ignores a lookup completion after disposal without publishing or scheduling', async () => {
    const h = harness()
    h.checks.start(); await flush()
    const state = h.checks.state
    h.checks.dispose()
    await h.finish(0, { status: 'behind' })
    expect(h.checks.state).toBe(state)
    expect(h.states).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not launch a queued lookup after disposal or pausing', async () => {
    const stopped = harness()
    stopped.checks.start(); stopped.checks.dispose(); await flush()
    expect(stopped.pending).toEqual([])
    expect(stopped.states).toHaveLength(1)
    const paused = harness()
    paused.checks.start(); paused.checks.setPaused(true); await flush()
    expect(paused.pending).toEqual([])
    expect(paused.checks.state.checking).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
