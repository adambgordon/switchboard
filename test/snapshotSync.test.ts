import { describe, expect, it } from 'vitest'
import { startSnapshotSync } from '../src/renderer/lib/snapshotSync'
import type { ConversationIndexSnapshot } from '../src/shared/types'
import type { UpdateCheckState } from '../src/shared/types'

describe('snapshot subscription', () => {
  it('keeps update status and activity together when a newer result beats the initial query', async () => {
    let push = (_snapshot: UpdateCheckState) => {}
    let finish = (_snapshot: UpdateCheckState) => {}
    const applied: UpdateCheckState[] = []
    const off = startSnapshotSync<UpdateCheckState>(
      (cb) => { push = cb; return () => {} },
      () => new Promise((resolve) => { finish = resolve }),
      (snapshot) => applied.push(snapshot)
    )
    push({ check: { status: 'behind' }, checking: false })
    finish({ check: { status: 'current' }, checking: true })
    await Promise.resolve()
    expect(applied).toEqual([{ check: { status: 'behind' }, checking: false }])
    off()
  })

  it('subscribes before requesting the seed and a pushed exclusion beats the delayed seed', async () => {
    let push = (_snapshot: ConversationIndexSnapshot) => {}
    let finish = (_snapshot: ConversationIndexSnapshot) => {}
    const applied: ConversationIndexSnapshot[] = []
    const off = startSnapshotSync<ConversationIndexSnapshot>(
      (cb) => { push = cb; return () => {} },
      () => {
        push({ groups: [], hiddenSessionIds: ['H'] })
        return new Promise((resolve) => { finish = resolve })
      },
      (snapshot) => applied.push(snapshot)
    )
    finish({ groups: [], hiddenSessionIds: [] })
    await Promise.resolve()
    expect(applied).toEqual([{ groups: [], hiddenSessionIds: ['H'] }])
    off()
    push({ groups: [], hiddenSessionIds: ['J'] })
    expect(applied).toHaveLength(1)
  })

  it('accepts the seed without a push and ignores late seeds after teardown', async () => {
    const applied: ConversationIndexSnapshot[] = []
    let finish = (_snapshot: ConversationIndexSnapshot) => {}
    let unsubscribed = false
    const api = {
      onSessionsChanged: () => () => { unsubscribed = true },
      listConversations: () => new Promise<ConversationIndexSnapshot>((resolve) => { finish = resolve })
    }
    const off = startSnapshotSync(api.onSessionsChanged, api.listConversations, (snapshot) => applied.push(snapshot))
    finish({ groups: [], hiddenSessionIds: ['H'] })
    await Promise.resolve()
    expect(applied).toEqual([{ groups: [], hiddenSessionIds: ['H'] }])
    off()
    expect(unsubscribed).toBe(true)
    const stop = startSnapshotSync(api.onSessionsChanged, api.listConversations, (snapshot) => applied.push(snapshot))
    stop()
    finish({ groups: [], hiddenSessionIds: ['J'] })
    await Promise.resolve()
    expect(applied).toHaveLength(1)
  })
})
