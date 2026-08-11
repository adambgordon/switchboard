import { describe, expect, it } from 'vitest'
import { startAnimationSync } from '../src/renderer/lib/animationSync'

interface TestAnimation {
  animationName: string
  startTime: number | null
}

function animation(animationName: string, startTime: number | null = 250): TestAnimation {
  return { animationName, startTime }
}

function harness(initial: TestAnimation[]) {
  const order: string[] = []
  let animations = initial
  let onAnimationStart: (() => void) | null = null
  let unsubscribes = 0

  const stop = startAnimationSync({
    subscribe: (listener) => {
      order.push('subscribe')
      onAnimationStart = listener
      return () => {
        unsubscribes++
        onAnimationStart = null
      }
    },
    getAnimations: () => {
      order.push('scan')
      return animations
    }
  })

  return {
    order,
    stop,
    setAnimations: (next: TestAnimation[]) => {
      animations = next
    },
    startAnimation: () => onAnimationStart?.(),
    unsubscribes: () => unsubscribes
  }
}

describe('startAnimationSync', () => {
  it('anchors existing matching animations and ignores unrelated ones', () => {
    const breathe = animation('sb-breathe-dot')
    const ripple = animation('sb-ripple', 400)
    const rippleCore = animation('sb-ripple-core', null)
    const entrance = animation('sb-fade-up', 700)

    harness([breathe, ripple, rippleCore, entrance])

    expect([breathe.startTime, ripple.startTime, rippleCore.startTime]).toEqual([0, 0, 0])
    expect(entrance.startTime).toBe(700)
  })

  it('subscribes before the initial scan', () => {
    const h = harness([])
    expect(h.order).toEqual(['subscribe', 'scan'])
  })

  it('anchors an animation that starts after the initial scan', () => {
    const h = harness([])
    const late = animation('sb-breathe-dot', 900)
    h.setAnimations([late])

    h.startAnimation()

    expect(late.startTime).toBe(0)
  })

  it('re-anchors a replaced animation', () => {
    const first = animation('sb-breathe-dot', 300)
    const h = harness([first])
    const replacement = animation('sb-breathe-dot', 800)
    h.setAnimations([replacement])

    h.startAnimation()

    expect(first.startTime).toBe(0)
    expect(replacement.startTime).toBe(0)
  })

  it('unsubscribes on teardown', () => {
    const h = harness([])
    const late = animation('sb-breathe-dot', 900)
    h.setAnimations([late])

    h.stop()
    h.startAnimation()

    expect(h.unsubscribes()).toBe(1)
    expect(late.startTime).toBe(900)
  })
})
