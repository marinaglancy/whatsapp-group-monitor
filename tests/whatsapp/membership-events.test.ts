import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { WASocket } from 'baileys'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser } from '../helpers/fixtures.js'
import { upsertMembership, syncGroupParticipants } from '../../src/db/queries/members.js'
import { handleGroupParticipantsUpdate } from '../../src/whatsapp/handlers/group-participants.js'
import { getAccountDb } from '../../src/db/account.js'
import { groupActivityLog, groupMembers } from '../../src/db/schema.js'
import { eq, and } from 'drizzle-orm'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => {
  dbs = setupTestDbs()
  seedGroup('g1@g.us', 'G1')
  for (const u of ['u1@lid', 'u2@lid', 'u3@lid', 'victim@lid']) seedUser(u)
})
afterEach(() => { dbs.cleanup() })

function membershipEvents(groupJid = 'g1@g.us') {
  const db = getAccountDb()
  return db.select().from(groupActivityLog)
    .where(and(eq(groupActivityLog.groupJid, groupJid)))
    .all()
    .filter(r => r.eventType === 'member_joined' || r.eventType === 'member_left')
}

describe('membership events', () => {
  it('emits member_joined on none -> active transitions only', () => {
    upsertMembership('g1@g.us', 'u1@lid', 'participant')
    upsertMembership('g1@g.us', 'u1@lid', 'participant') // no change
    upsertMembership('g1@g.us', 'u1@lid', 'admin') // promote: still active, no event
    const evs = membershipEvents()
    expect(evs.map(e => e.eventType)).toEqual(['member_joined'])
    expect(evs[0].userJid).toBe('u1@lid')
  })

  it('emits member_left on active -> none, and member_joined again on rejoin', () => {
    upsertMembership('g1@g.us', 'u1@lid', 'participant')
    upsertMembership('g1@g.us', 'u1@lid', 'none')
    upsertMembership('g1@g.us', 'u1@lid', 'participant')
    expect(membershipEvents().map(e => e.eventType)).toEqual(['member_joined', 'member_left', 'member_joined'])
  })

  it('keeps joined_at stable across resyncs of an unchanged member', async () => {
    const { getGroupMembers } = await import('../../src/db/queries/members.js')
    syncGroupParticipants('g1@g.us', [{ id: 'u1@lid' }] as never) // baseline
    const first = getGroupMembers('g1@g.us')[0].joinedAt
    await new Promise(r => setTimeout(r, 5))
    syncGroupParticipants('g1@g.us', [{ id: 'u1@lid' }] as never) // resync, no change
    expect(getGroupMembers('g1@g.us')[0].joinedAt).toEqual(first)
  })

  it('suppresses events on the baseline sync of a group with no known members', () => {
    syncGroupParticipants('g1@g.us', [
      { id: 'u1@lid' }, { id: 'u2@lid', admin: 'admin' },
    ] as never)
    expect(membershipEvents()).toEqual([])
  })

  it('leaves joined_at empty for baseline roster members (join date unknown)', () => {
    syncGroupParticipants('g1@g.us', [
      { id: 'u1@lid' }, { id: 'u2@lid' },
    ] as never)
    const db = getAccountDb()
    const rows = db.select().from(groupMembers).where(eq(groupMembers.groupJid, 'g1@g.us')).all()
    expect(rows.length).toBe(2)
    for (const r of rows) expect(r.joinedAt).toBeNull()
    // a member appearing later in the known roster genuinely joined now
    syncGroupParticipants('g1@g.us', [
      { id: 'u1@lid' }, { id: 'u2@lid' }, { id: 'u3@lid' },
    ] as never)
    const u3 = db.select().from(groupMembers)
      .where(and(eq(groupMembers.groupJid, 'g1@g.us'), eq(groupMembers.userJid, 'u3@lid'))).get()!
    expect(u3.joinedAt).not.toBeNull()
  })

  it('emits joins and leaves from sync diffs on an already-known group', () => {
    syncGroupParticipants('g1@g.us', [{ id: 'u1@lid' }, { id: 'u2@lid' }] as never) // baseline
    syncGroupParticipants('g1@g.us', [{ id: 'u2@lid' }, { id: 'u3@lid' }] as never) // u1 left, u3 joined
    const evs = membershipEvents()
    expect(evs.map(e => [e.eventType, e.userJid]).sort()).toEqual([
      ['member_joined', 'u3@lid'],
      ['member_left', 'u1@lid'],
    ])
    expect((evs[0].metadata as { source: string }).source).toBe('sync')
  })

  it('records the acting admin from live participant updates', async () => {
    upsertMembership('g1@g.us', 'victim@lid', 'participant')
    const sock = { user: { id: '15550001234:1@s.whatsapp.net' } } as unknown as WASocket
    await handleGroupParticipantsUpdate({
      id: 'g1@g.us', author: 'admin@lid', participants: [{ id: 'victim@lid' }], action: 'remove',
    } as never, sock)
    const evs = membershipEvents()
    expect(evs.map(e => e.eventType)).toEqual(['member_joined', 'member_left'])
    const left = evs[1].metadata as { actor?: string; source: string }
    expect(left.actor).toBe('admin@lid')
    expect(left.source).toBe('event')
  })
})
