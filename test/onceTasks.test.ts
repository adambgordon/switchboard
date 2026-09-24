import { describe, expect, it } from 'vitest'
import { parseOnceTasks, withOnceTask } from '../src/renderer/lib/onceTasks'

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
