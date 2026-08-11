interface SyncableAnimation {
  animationName: string
  startTime: unknown
}

interface AnimationSyncDeps {
  subscribe: (onAnimationStart: () => void) => () => void
  getAnimations: () => Iterable<SyncableAnimation>
}

const SYNCED_ANIMATIONS = new Set(['sb-breathe-dot', 'sb-ripple', 'sb-ripple-core'])

export function startAnimationSync(deps: AnimationSyncDeps): () => void {
  const sync = (): void => {
    for (const animation of deps.getAnimations()) {
      if (SYNCED_ANIMATIONS.has(animation.animationName)) animation.startTime = 0
    }
  }

  const unsubscribe = deps.subscribe(sync)
  sync()
  return unsubscribe
}
