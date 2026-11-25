import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedMember, seedMessage } from '../helpers/fixtures.js'
import { getAccountDb } from '../../src/db/account.js'
import { groupMembers } from '../../src/db/schema.js'
import { and, eq } from 'drizzle-orm'
import { senderNotAdmin, joinedWithinDays, fewerMessagesThan } from '../../src/triggers/conditions.js'
import type { TriggerEvent } from '../../src/triggers/types.js'

const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000
const ctx = { nowMs: NOW_MS, botJids: [] }
let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs(); seedGroup('g@g.us', 'G') })
afterEach(() => { dbs.cleanup() })

const ev = (): TriggerEvent => ({
  kind: 'group_message',
  record: { groupJid: 'g@g.us', userJid: 'u@lid', messageId: 'M', parentId: null, eventType: 'message', metadata: { text: 'x' }, timestamp: NOW_S },
})
const setJoined = (d: Date | null) =>
  getAccountDb().update(groupMembers).set({ joinedAt: d }).where(and(eq(groupMembers.groupJid, 'g@g.us'), eq(groupMembers.userJid, 'u@lid'))).run()

describe('senderNotAdmin', () => {
  const cond = senderNotAdmin<{ on: boolean }>(c => c.on)
  it('fails for admins and superadmins, passes for participants and unknown senders', () => {
    seedMember('g@g.us', 'u@lid', 'participant')
    expect(cond.check(ev(), { on: true }, ctx)).toBe(true)
    getAccountDb().update(groupMembers).set({ membership: 'admin' }).run()
    expect(cond.check(ev(), { on: true }, ctx)).toBe(false)
    getAccountDb().update(groupMembers).set({ membership: 'superadmin' }).run()
    expect(cond.check(ev(), { on: true }, ctx)).toBe(false)
  })
  it('passes when off, and when the sender is unknown', () => {
    expect(cond.check(ev(), { on: true }, ctx)).toBe(true)
    seedMember('g@g.us', 'u@lid', 'admin')
    expect(cond.check(ev(), { on: false }, ctx)).toBe(true)
  })
})

describe('joinedWithinDays', () => {
  const cond = joinedWithinDays<{ d: number | null }>(c => c.d)
  it('is off when null', () => {
    expect(cond.check(ev(), { d: null }, ctx)).toBe(true)
  })
  it('passes a recent joiner, fails an old one and an unknown join date', () => {
    seedMember('g@g.us', 'u@lid')
    setJoined(null)
    expect(cond.check(ev(), { d: 7 }, ctx)).toBe(false)
    setJoined(new Date(NOW_MS - 2 * 86_400_000))
    expect(cond.check(ev(), { d: 7 }, ctx)).toBe(true)
    setJoined(new Date(NOW_MS - 30 * 86_400_000))
    expect(cond.check(ev(), { d: 7 }, ctx)).toBe(false)
  })
  it('fails when the sender is not a known member', () => {
    expect(cond.check(ev(), { d: 7 }, ctx)).toBe(false)
  })
})

describe('fewerMessagesThan', () => {
  const cond = fewerMessagesThan<{ n: number | null }>(c => c.n)
  it('counts only earlier messages of this user in this group', () => {
    seedGroup('h@g.us', 'H')
    seedMessage('g@g.us', 'u@lid', 'a', NOW_S - 100)
    seedMessage('g@g.us', 'u@lid', 'b', NOW_S - 50)
    seedMessage('g@g.us', 'u@lid', 'this', NOW_S) // not before itself
    seedMessage('g@g.us', 'other@lid', 'c', NOW_S - 10)
    seedMessage('h@g.us', 'u@lid', 'd', NOW_S - 10)
    seedMessage('g@g.us', 'u@lid', 'r', NOW_S - 5, { eventType: 'reaction' })
    expect(cond.check(ev(), { n: 3 }, ctx)).toBe(true)
    expect(cond.check(ev(), { n: 2 }, ctx)).toBe(false)
    expect(cond.check(ev(), { n: null }, ctx)).toBe(true)
  })
  it('passes for a first message', () => {
    expect(cond.check(ev(), { n: 1 }, ctx)).toBe(true)
  })
})
