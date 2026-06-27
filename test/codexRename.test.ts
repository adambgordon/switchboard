import { describe, it, expect } from 'vitest'
import { createRenameProtocol } from '../src/main/sessions/codexRename'

const TID = '019f0472-b681-7000-8a52-bc5ac4fc1544'
const NAME = 'My renamed thread'

describe('createRenameProtocol', () => {
  it('starts with an initialize request carrying clientInfo', () => {
    const p = createRenameProtocol(TID, NAME)
    const start = p.start()
    expect(start).toHaveLength(1)
    expect(start[0]).toMatchObject({ id: 1, method: 'initialize' })
    const params = start[0].params as { clientInfo: { name: string; version: string } }
    expect(typeof params.clientInfo.name).toBe('string')
    expect(typeof params.clientInfo.version).toBe('string')
  })

  it('on the initialize response, sends initialized + thread/name/set with the threadId and name', () => {
    const p = createRenameProtocol(TID, NAME)
    const step = p.next({ id: 1, result: { codexHome: '/x' } })
    expect(step.done).toBeUndefined()
    expect(step.send).toHaveLength(2)
    expect(step.send[0]).toEqual({ method: 'initialized' })
    expect(step.send[1]).toEqual({ id: 2, method: 'thread/name/set', params: { threadId: TID, name: NAME } })
  })

  it('resolves ok on the thread/name/set response', () => {
    const p = createRenameProtocol(TID, NAME)
    const step = p.next({ id: 2, result: {} })
    expect(step.done).toBe('ok')
    expect(step.send).toEqual([])
  })

  it('errors when initialize fails', () => {
    const p = createRenameProtocol(TID, NAME)
    const step = p.next({ id: 1, error: { code: -1, message: 'boom' } })
    expect(step.done).toBe('error')
    expect(step.error).toContain('boom')
    expect(step.send).toEqual([])
  })

  it('errors when thread/name/set fails', () => {
    const p = createRenameProtocol(TID, NAME)
    const step = p.next({ id: 2, error: { message: 'no such thread' } })
    expect(step.done).toBe('error')
    expect(step.error).toContain('no such thread')
  })

  it('ignores unsolicited notifications (no id, no result)', () => {
    const p = createRenameProtocol(TID, NAME)
    const step = p.next({ method: 'remoteControl/status/changed', params: { status: 'disabled' } })
    expect(step.done).toBeUndefined()
    expect(step.send).toEqual([])
  })

  it('ignores a name-updated notification echoed back by the server', () => {
    const p = createRenameProtocol(TID, NAME)
    const step = p.next({ method: 'thread/name/updated', params: { threadId: TID, threadName: NAME } })
    expect(step.done).toBeUndefined()
    expect(step.send).toEqual([])
  })
})
