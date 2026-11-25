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
})
