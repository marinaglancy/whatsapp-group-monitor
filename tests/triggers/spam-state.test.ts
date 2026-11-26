import { describe, it, expect } from 'vitest'
import { mergeState, sameState } from '../../src/triggers/spam/state.js'
import type { SpamCaseState } from '../../src/db/schema.js'

const state = (over: Partial<SpamCaseState> = {}): SpamCaseState =>
  ({ notDeleted: [], deleted: [], removedFrom: [], notRemovedFrom: [], ...over })

describe('mergeState', () => {
  it('without an earlier state, removes repeats and lets "done" win inside the job', () => {
    expect(mergeState(null, state({ notDeleted: ['a', 'b', 'a'], deleted: ['b'], removedFrom: ['c'], notRemovedFrom: ['c', 'd'] })))
      .toEqual(state({ notDeleted: ['a'], deleted: ['b'], removedFrom: ['c'], notRemovedFrom: ['d'] }))
  })

  it('adds new groups after the earlier ones, and moves a group once it is done', () => {
    const earlier = state({ notDeleted: ['a', 'b'], deleted: ['c'], removedFrom: ['x'], notRemovedFrom: ['y', 'z'] })
    expect(mergeState(earlier, state({ notDeleted: ['d'], deleted: ['b'], removedFrom: ['z'] })))
      .toEqual(state({ notDeleted: ['a', 'd'], deleted: ['c', 'b'], removedFrom: ['x', 'z'], notRemovedFrom: ['y'] }))
  })

  it('never moves a group back from done', () => {
    const earlier = state({ deleted: ['a'], removedFrom: ['a'] })
    expect(mergeState(earlier, state({ notDeleted: ['a'], notRemovedFrom: ['a'] }))).toEqual(earlier)
  })

  it('keeps "removed" from the community once it happened, and has no community when none was tried', () => {
    const removed = state({ community: 'removed' })
    const refused = state({ community: 'not_removed' })
    expect(mergeState(removed, refused).community).toBe('removed')
    expect(mergeState(refused, removed).community).toBe('removed')
    expect(mergeState(null, refused).community).toBe('not_removed')
    expect(mergeState(refused, state()).community).toBe('not_removed')
    expect(mergeState(state(), state())).not.toHaveProperty('community')
  })
})

describe('sameState', () => {
  it('compares the lists as sets, and the community', () => {
    const a = state({ notDeleted: ['a', 'b'], deleted: ['c'], removedFrom: ['d'], notRemovedFrom: ['e'], community: 'removed' })
    expect(sameState(a, { ...a, notDeleted: ['b', 'a'] })).toBe(true)
    expect(sameState(a, { ...a, notDeleted: ['a'] })).toBe(false)
    expect(sameState(a, { ...a, notDeleted: ['a', 'b', 'f'] })).toBe(false)
    expect(sameState(a, { ...a, deleted: [] })).toBe(false)
    expect(sameState(a, { ...a, removedFrom: ['x'] })).toBe(false)
    expect(sameState(a, { ...a, notRemovedFrom: [] })).toBe(false)
    expect(sameState(a, { ...a, community: 'not_removed' })).toBe(false)
    expect(sameState(state(), state())).toBe(true)
  })
})
