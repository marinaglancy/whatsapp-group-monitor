import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedMessage } from '../helpers/fixtures.js'
import { findRecentCase, createCase, updateCaseReport } from '../../src/db/queries/spam-cases.js'
import { isMessageDeleted, findUserCopies } from '../../src/db/queries/activity.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs() })
afterEach(() => { dbs.cleanup() })

describe('spam cases', () => {
  it('finds the newest case inside the window only', () => {
    const v = { isspam: true, isspammer: true, reason: 'r' }
    createCase({ triggerId: 1, userJid: 'u@lid', textKey: 'k', verdict: v, now: 1000 })
    const newer = createCase({ triggerId: 1, userJid: 'u@lid', textKey: 'k', verdict: v, now: 2000 })
    expect(findRecentCase(1, 'u@lid', 'k', 500)!.id).toBe(newer)
    expect(findRecentCase(1, 'u@lid', 'k', 2000)!.id).toBe(newer)
    expect(findRecentCase(1, 'u@lid', 'k', 2001)).toBeNull()
    expect(findRecentCase(2, 'u@lid', 'k', 0)).toBeNull()
    expect(findRecentCase(1, 'other@lid', 'k', 0)).toBeNull()
    expect(findRecentCase(1, 'u@lid', 'other', 0)).toBeNull()
  })
  it('stores the report and its state', () => {
    const id = createCase({ triggerId: 1, userJid: 'u@lid', textKey: 'k', verdict: { isspam: true } })
    updateCaseReport(id, { reportGroupJid: 'n@g.us', reportMessageId: 'R1', reportPostedAt: 5, state: { notDeleted: ['a@g.us'], deleted: [], removal: 'x' } })
    const c = findRecentCase(1, 'u@lid', 'k', 0)!
    expect(c.reportMessageId).toBe('R1')
    expect(c.reportGroupJid).toBe('n@g.us')
    expect(c.reportPostedAt).toBe(5)
    expect(c.state).toEqual({ notDeleted: ['a@g.us'], deleted: [], removal: 'x' })
    expect(c.verdict).toEqual({ isspam: true })
  })
})

describe('activity helpers', () => {
  it('isMessageDeleted sees a delete row', () => {
    const id = seedMessage('a@g.us', 'u@lid', 'x', 1)
    expect(isMessageDeleted('a@g.us', id)).toBe(false)
    seedMessage('a@g.us', 'u@lid', '', 2, { eventType: 'delete', parentId: id, metadata: {} })
    expect(isMessageDeleted('a@g.us', id)).toBe(true)
    expect(isMessageDeleted('b@g.us', id)).toBe(false)
  })
  it('findUserCopies uses the latest text and skips deleted, other users and other groups', () => {
    const plain = seedMessage('a@g.us', 'u@lid', 'Buy   now', 1)
    const edited = seedMessage('b@g.us', 'u@lid', 'hello', 2)
    seedMessage('b@g.us', 'u@lid', 'Buy now', 3, { eventType: 'edit', parentId: edited, metadata: { text: 'Buy now' } })
    const editedAway = seedMessage('a@g.us', 'u@lid', 'Buy now', 4)
    seedMessage('a@g.us', 'u@lid', 'bye', 5, { eventType: 'edit', parentId: editedAway, metadata: { text: 'bye' } })
    const gone = seedMessage('c@g.us', 'u@lid', 'Buy now', 6)
    seedMessage('c@g.us', 'u@lid', '', 7, { eventType: 'delete', parentId: gone, metadata: {} })
    seedMessage('a@g.us', 'x@lid', 'Buy now', 8)
    seedMessage('d@g.us', 'u@lid', 'Buy now', 9)
    const r = findUserCopies(['a@g.us', 'b@g.us', 'c@g.us'], 'u@lid', 'Buy now')
    expect(r.map(c => c.messageId).sort()).toEqual([plain, edited].sort())
    expect(r.find(c => c.messageId === edited)).toEqual({ groupJid: 'b@g.us', messageId: edited, timestamp: 2 })
    expect(findUserCopies([], 'u@lid', 'Buy now')).toEqual([])
  })
  it('the last edit decides, not the first', () => {
    const match = seedMessage('a@g.us', 'u@lid', 'A', 1)
    seedMessage('a@g.us', 'u@lid', 'B', 2, { eventType: 'edit', parentId: match, metadata: { text: 'B' } })
    seedMessage('a@g.us', 'u@lid', 'Buy now', 3, { eventType: 'edit', parentId: match, metadata: { text: 'Buy now' } })
    const noMatch = seedMessage('a@g.us', 'u@lid', 'Buy now', 4)
    seedMessage('a@g.us', 'u@lid', 'X', 5, { eventType: 'edit', parentId: noMatch, metadata: { text: 'X' } })
    seedMessage('a@g.us', 'u@lid', 'bye', 6, { eventType: 'edit', parentId: noMatch, metadata: { text: 'bye' } })
    expect(findUserCopies(['a@g.us'], 'u@lid', 'Buy now').map(c => c.messageId)).toEqual([match])
  })
  it('handles a user with more than 1000 messages', () => {
    for (let i = 0; i < 1200; i++) seedMessage('a@g.us', 'u@lid', `chat ${i}`, i)
    const hit = seedMessage('a@g.us', 'u@lid', 'Buy now', 2000)
    const edited = seedMessage('a@g.us', 'u@lid', 'old', 2001)
    seedMessage('a@g.us', 'u@lid', 'Buy now', 2002, { eventType: 'edit', parentId: edited, metadata: { text: 'Buy now' } })
    expect(findUserCopies(['a@g.us'], 'u@lid', 'Buy now').map(c => c.messageId).sort()).toEqual([hit, edited].sort())
  })
  it('the latest edit decides even when edits were stored out of order', () => {
    const id = seedMessage('a@g.us', 'u@lid', 'A', 1)
    seedMessage('a@g.us', 'u@lid', 'Buy now', 3, { eventType: 'edit', parentId: id, metadata: { text: 'Buy now' } })
    seedMessage('a@g.us', 'u@lid', 'X', 2, { eventType: 'edit', parentId: id, metadata: { text: 'X' } })
    expect(findUserCopies(['a@g.us'], 'u@lid', 'Buy now').map(c => c.messageId)).toEqual([id])
  })
})
