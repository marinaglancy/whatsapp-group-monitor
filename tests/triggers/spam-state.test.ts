import { describe, it, expect } from 'vitest'
import { mergeState, sameState } from '../../src/triggers/spam/state.js'
import type { SpamCaseState } from '../../src/db/schema.js'

const state = (over: Partial<SpamCaseState> = {}): SpamCaseState =>
  ({ notDeleted: [], deleted: [], removedFrom: [], notRemovedFrom: [], ...over })
/** ca and cb are in community com; c is not. */
const communityOf = (jid: string) => (jid === 'ca' || jid === 'cb' ? 'com' : null)
const merge = (earlier: SpamCaseState | null, fresh: SpamCaseState) => mergeState(earlier, fresh, communityOf)

describe('mergeState', () => {
  it('without an earlier state, removes repeats and lets "done" win inside the job', () => {
    expect(merge(null, state({ notDeleted: ['a', 'b', 'a'], deleted: ['b'], removedFrom: ['c'], notRemovedFrom: ['c', 'd'] })))
      .toEqual(state({ notDeleted: ['a'], deleted: ['b'], removedFrom: ['c'], notRemovedFrom: ['d'] }))
  })

  it('adds new groups after the earlier ones, and moves a group once it is done', () => {
    const earlier = state({ notDeleted: ['a', 'b'], deleted: ['c'], removedFrom: ['x'], notRemovedFrom: ['y', 'z'] })
    expect(merge(earlier, state({ notDeleted: ['d'], deleted: ['b'], removedFrom: ['z'] })))
      .toEqual(state({ notDeleted: ['a', 'd'], deleted: ['c', 'b'], removedFrom: ['x', 'z'], notRemovedFrom: ['y'] }))
  })

  it('never moves a group back from done', () => {
    const earlier = state({ deleted: ['a'], removedFrom: ['a'] })
    expect(merge(earlier, state({ notDeleted: ['a'], notRemovedFrom: ['a'] }))).toEqual(earlier)
  })

  it('keeps "removed" from the community once it happened, and has no community when none was tried', () => {
    const removed = state({ community: 'removed' })
    const refused = state({ community: 'not_removed' })
    expect(merge(removed, refused).community).toBe('removed')
    expect(merge(refused, removed).community).toBe('removed')
    expect(merge(null, refused).community).toBe('not_removed')
    expect(merge(refused, state()).community).toBe('not_removed')
    expect(merge(state(), state())).not.toHaveProperty('community')
  })

  it('drops the groups of a community the user was removed from out of "could not remove"', () => {
    const groupByGroup = state({ removedFrom: ['c'], notRemovedFrom: ['ca', 'cb', 'd'] })
    const fromCommunity = state({ community: 'removed', communityJid: 'com' })
    expect(merge(groupByGroup, fromCommunity))
      .toEqual(state({ removedFrom: ['c'], notRemovedFrom: ['d'], community: 'removed', communityJid: 'com' }))
    // and the other way round: a later job lists them again
    expect(merge(fromCommunity, groupByGroup).notRemovedFrom).toEqual(['d'])
    // a refused community removal leaves them
    expect(merge(groupByGroup, state({ community: 'not_removed', communityJid: 'com' })).notRemovedFrom).toEqual(['ca', 'cb', 'd'])
  })

  it('keeps the community id that goes with the status it keeps, also from a row saved without one', () => {
    const old = state({ community: 'removed', notRemovedFrom: ['ca'] })
    expect(merge(old, state({ community: 'removed', communityJid: 'com' })))
      .toEqual(state({ community: 'removed', communityJid: 'com' }))
    expect(merge(state({ community: 'not_removed', communityJid: 'other' }), state({ community: 'removed', communityJid: 'com' })))
      .toMatchObject({ community: 'removed', communityJid: 'com' })
    expect(merge(state({ community: 'removed', communityJid: 'com' }), state({ community: 'not_removed', communityJid: 'other' })))
      .toMatchObject({ community: 'removed', communityJid: 'com' })
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
    // the report does not show the community id
    expect(sameState(a, { ...a, communityJid: 'com' })).toBe(true)
  })
})
