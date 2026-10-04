import { describe, expect, it } from 'vitest'
import { parseOnceTasks, unseenWhatsNew, withOnceTask } from '../src/renderer/lib/onceTasks'

describe('parseOnceTasks', () => {
  it('reads the stored task ids, keeping only strings', () => {
    expect(parseOnceTasks('["folderSeed", 3, null, "welcome"]')).toEqual(['folderSeed', 'welcome'])
  })

  it('reads anything missing or malformed as nothing done', () => {
    for (const raw of [null, '', '{', '{"folderSeed":true}', '"folderSeed"']) expect(parseOnceTasks(raw)).toEqual([])
  })
})

describe('withOnceTask', () => {
  it('adds a task, keeping the ones another window already recorded', () => {
    expect(withOnceTask(['welcome'], 'folderSeed')).toEqual(['welcome', 'folderSeed'])
  })

  it('returns the same list when the task is already done', () => {
    const done = ['folderSeed']
    expect(withOnceTask(done, 'folderSeed')).toBe(done)
  })
})

describe('unseenWhatsNew', () => {
  it('shows a profile that has seen nothing every release, newest first', () => {
    expect(unseenWhatsNew([])).toEqual(['whatsNew:2', 'whatsNew:1'])
  })

  it('shows only the releases not yet seen', () => {
    expect(unseenWhatsNew(['folderSeed', 'whatsNew:1'])).toEqual(['whatsNew:2'])
    expect(unseenWhatsNew(['whatsNew:2'])).toEqual(['whatsNew:1'])
  })

  it('shows nothing once every release is seen', () => {
    expect(unseenWhatsNew(['whatsNew:2', 'folderSeed', 'whatsNew:1'])).toEqual([])
  })
})
