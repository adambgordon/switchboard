/** Subscribe before reading the seed; a push during that read is the newer snapshot. */
export function startSnapshotSync<T>(
  subscribe: (apply: (snapshot: T) => void) => () => void,
  getSnapshot: () => Promise<T>,
  apply: (snapshot: T) => void
): () => void {
  let alive = true
  let pushed = false
  const off = subscribe((snapshot) => {
    pushed = true
    if (alive) apply(snapshot)
  })
  void getSnapshot().then((snapshot) => {
    if (alive && !pushed) apply(snapshot)
  }).catch(() => {})
  return () => { alive = false; off() }
}
