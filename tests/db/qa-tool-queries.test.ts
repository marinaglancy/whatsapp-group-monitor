import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMember, seedMessage } from '../helpers/fixtures.js'
import { qGroupMembers, qGroupMessages, qActivityStats, qSearchMessages } from '../../src/db/queries/qa-tools.js'

const ANNA = 'anna@lid'
const BORIS = 'boris@lid'
const CARL = 'carl@lid'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => {
  dbs = setupTestDbs()
  seedGroup('a@g.us', 'Alpha')
  seedGroup('b@g.us', 'Beta')
  seedUser(ANNA, 'Anna', '351911111111')
  seedUser(BORIS, 'Boris', null)
  seedUser(CARL, null, '351933333333')
  seedMember('a@g.us', ANNA, 'admin')
  seedMember('a@g.us', BORIS)
  seedMember('a@g.us', CARL)
  seedMember('b@g.us', ANNA)

  // conversation in Alpha
  seedMessage('a@g.us', ANNA, 'hello world', 1000, { messageId: 'M1' })
  seedMessage('a@g.us', BORIS, 'the picnic plan', 2000, { messageId: 'M2', parentId: 'M1', metadata: { contentType: 'conversation', text: 'the picnic plan', isReply: true } })
  seedMessage('a@g.us', BORIS, '', 2100, { eventType: 'edit', parentId: 'M2', metadata: { contentType: 'conversation', text: 'the picnic plan v2' } })
  seedMessage('a@g.us', ANNA, '', 2200, { eventType: 'reaction', parentId: 'M2', metadata: { emoji: '👍' } })
  seedMessage('a@g.us', CARL, 'look', 3000, { messageId: 'M3', metadata: { contentType: 'imageMessage', text: 'look' } })
  seedMessage('a@g.us', BORIS, '', 4000, { messageId: 'M4', metadata: { contentType: 'documentMessage' }, raw: { message: { documentMessage: { fileName: 'report.pdf' } } } })
  seedMessage('a@g.us', ANNA, '', 5000, { messageId: 'M5', eventType: 'poll_create', metadata: { question: 'Training Tue?', options: ['Yes', 'No'] } })
  seedMessage('a@g.us', BORIS, '', 5100, { eventType: 'poll_vote', parentId: 'M5', metadata: { selectedOptions: ['Yes'] } })
  seedMessage('a@g.us', CARL, '', 5200, { eventType: 'poll_vote', parentId: 'M5', metadata: { selectedOptions: ['No'] } })
  seedMessage('a@g.us', ANNA, '', 6000, { messageId: 'M6', eventType: 'event_create', metadata: { name: 'Beach day', startTime: 999999, isCanceled: false } })
  seedMessage('a@g.us', BORIS, '', 6100, { eventType: 'event_response', parentId: 'M6', metadata: { response: 'GOING' } })
  seedMessage('a@g.us', ANNA, 'delete me', 7000, { messageId: 'M7' })
  seedMessage('a@g.us', BORIS, '', 7100, { eventType: 'delete', parentId: 'M7' }) // admin delete of Anna's message
  seedMessage('a@g.us', BORIS, 'self deleted', 7500, { messageId: 'M8' })
  seedMessage('a@g.us', BORIS, '', 7600, { eventType: 'delete', parentId: 'M8' }) // own delete
  seedMessage('a@g.us', BORIS, '', 9500, { messageId: 'M9', metadata: { contentType: 'audioMessage' }, raw: { message: { audioMessage: { ptt: true } } } })
  seedMessage('a@g.us', ANNA, 'mentioning @9876 by token', 9600, { messageId: 'M10' })
  // membership events
  seedMessage('a@g.us', CARL, '', 8000, { eventType: 'member_joined', metadata: { source: 'sync' } })
  seedMessage('a@g.us', 'dave@lid', '', 8100, { eventType: 'member_left', metadata: { source: 'event', actor: ANNA } })
  // Beta
  seedMessage('b@g.us', ANNA, 'beta chatter', 9000, { messageId: 'B1' })
})
afterEach(() => { dbs.cleanup() })

const A = ['a@g.us']
const AB = ['a@g.us', 'b@g.us']

describe('qGroupMembers', () => {
  const base = { fields: new Set<string>(['phone', 'role', 'last_activity', 'activity_count', 'groups']), activityFrom: 0, activityTo: 10_000, filters: {}, includeLeft: false, orderBy: 'lid', order: 'asc' as const, limit: 50, offset: 0 }

  it('returns one row per member with activity computed over the window', () => {
    const { members, total } = qGroupMembers({ groupJids: AB }, base)
    expect(total).toBe(3)
    const anna = members.find(m => m.lid === ANNA)!
    // Anna: M1, reaction, M5 poll, M6 event, M7, M10 in Alpha + B1 in Beta = 7 (primary+secondary only)
    expect(anna.activityCount).toBe(7)
    expect(anna.lastActivity).toBe(9600)
    expect(anna.phone).toBe('351911111111')
    expect(anna.role).toBe('admin')
    expect(anna.groups!.sort()).toEqual(AB)
    const carl = members.find(m => m.lid === CARL)!
    expect(carl.name).toBeNull()
    // Carl: M3 + poll vote = 2 (member_joined is not activity)
    expect(carl.activityCount).toBe(2)
  })

  it('activity window bounds and inactive filter work', () => {
    const { members } = qGroupMembers({ groupJids: A }, { ...base, activityFrom: 9990, activityTo: 10_000, filters: { maxActivityCount: 0 } })
    expect(members.map(m => m.lid).sort()).toEqual([ANNA, BORIS, CARL].sort())
    const { members: active } = qGroupMembers({ groupJids: A }, { ...base, filters: { minActivityCount: 1 } })
    expect(active.length).toBe(3)
  })

  it('filters by name/phone/role and orders with lid tie-break following direction', () => {
    expect(qGroupMembers({ groupJids: A }, { ...base, filters: { nameContains: 'ann' } }).members.map(m => m.lid)).toEqual([ANNA])
    expect(qGroupMembers({ groupJids: A }, { ...base, filters: { phoneContains: '3333' } }).members.map(m => m.lid)).toEqual([CARL])
    expect(qGroupMembers({ groupJids: A }, { ...base, filters: { role: 'admin' } }).members.map(m => m.lid)).toEqual([ANNA])
    const asc = qGroupMembers({ groupJids: A }, { ...base, orderBy: 'activity_count', order: 'asc' }).members.map(m => m.lid)
    const desc = qGroupMembers({ groupJids: A }, { ...base, orderBy: 'activity_count', order: 'desc' }).members.map(m => m.lid)
    expect(desc).toEqual([...asc].reverse())
  })

  it('pages with a stable order and reports total', () => {
    const p1 = qGroupMembers({ groupJids: A }, { ...base, limit: 2, offset: 0 })
    const p2 = qGroupMembers({ groupJids: A }, { ...base, limit: 2, offset: 2 })
    expect(p1.total).toBe(3)
    expect([...p1.members, ...p2.members].map(m => m.lid)).toEqual([ANNA, BORIS, CARL].sort())
  })
})

describe('qGroupMessages', () => {
  const base = { from: 0, to: 100_000, includeDeleted: false, order: 'asc' as const, limit: 50, offset: 0 }

  it('returns the resolved participant view', () => {
    const { messages, total } = qGroupMessages({ groupJids: A }, base)
    // M1, M2, M3, M4, M5, M6, M9, M10 visible; M7, M8 deleted
    expect(total).toBe(8)
    const m2 = messages.find(m => m.messageId === 'M2')!
    expect(m2.text).toBe('the picnic plan v2')
    expect(m2.edited).toBe(true)
    expect(m2.replyToId).toBe('M1')
    expect(m2.reactions).toEqual([{ emoji: '👍', by: [ANNA] }])
    const m5 = messages.find(m => m.messageId === 'M5')!
    expect(m5.poll!.question).toBe('Training Tue?')
    expect(m5.poll!.options).toEqual([
      { text: 'Yes', votes: [BORIS] },
      { text: 'No', votes: [CARL] },
    ])
    const m6 = messages.find(m => m.messageId === 'M6')!
    expect(m6.event!.name).toBe('Beach day')
    expect(m6.event!.responses.going).toEqual([BORIS])
    const m4 = messages.find(m => m.messageId === 'M4')!
    expect(m4.media).toBe('document: report.pdf')
    const m9 = messages.find(m => m.messageId === 'M9')!
    expect(m9.media).toBe('voice message')
    const m3 = messages.find(m => m.messageId === 'M3')!
    expect(m3.media).toBe('image')
    expect(m3.text).toBe('look')
  })

  it('includes deleted messages with deleted_by only when asked', () => {
    const withDeleted = qGroupMessages({ groupJids: A }, { ...base, includeDeleted: true })
    expect(withDeleted.total).toBe(10)
    const m7 = withDeleted.messages.find(m => m.messageId === 'M7')!
    expect(m7.deleted).toBe(true)
    expect(m7.deletedBy).toBe(BORIS)
    expect(m7.text).toBe('delete me') // last known content is retained
  })

  it('filters by type, reactions and date range with paging', () => {
    expect(qGroupMessages({ groupJids: A }, { ...base, types: ['poll'] }).messages.map(m => m.messageId)).toEqual(['M5'])
    expect(qGroupMessages({ groupJids: A }, { ...base, hasReactions: true }).messages.map(m => m.messageId)).toEqual(['M2'])
    expect(qGroupMessages({ groupJids: A }, { ...base, from: 2500, to: 4500 }).messages.map(m => m.messageId)).toEqual(['M3', 'M4'])
    const desc = qGroupMessages({ groupJids: A }, { ...base, order: 'desc', limit: 2, offset: 0 })
    expect(desc.messages.map(m => m.messageId)).toEqual(['M10', 'M9'])
    expect(desc.hasMoreRows).toBe(true)
  })

  it('member involvement filter covers all the legs', () => {
    const ids = (memberLid: string, memberPhone: string | null = null) =>
      qGroupMessages({ groupJids: A }, { ...base, includeDeleted: true, memberLid, memberPhone }).messages.map(m => m.messageId)
    // Carl: authored M3, voted in M5, mentioned via text token in M10 (lid digits 9876? no — carl@lid bare is 'carl'); use a digit-lid member below for mentions
    expect(ids(CARL)).toEqual(['M3', 'M5'])
    // Boris: authored M2/M4/M8/M9; replied to M1 (M2 is his reply, so M1 is involved);
    // voted M5, responded M6, deleted M7 (admin delete) and M8
    expect(ids(BORIS)).toEqual(['M1', 'M2', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'])
    // Anna: authored M1/M5/M6/M7/M10, reacted to M2, and M2 is a reply TO her message M1 (already counted via authorship of M1)
    expect(ids(ANNA)).toEqual(['M1', 'M2', 'M5', 'M6', 'M7', 'M10'])
  })

  it('matches mentions via text token with digit identities', () => {
    seedUser('9876@lid', 'Digit Member')
    seedMember('a@g.us', '9876@lid')
    const ids = qGroupMessages({ groupJids: A }, { ...base, memberLid: '9876@lid' }).messages.map(m => m.messageId)
    expect(ids).toEqual(['M10'])
  })
})

describe('qActivityStats', () => {
  it('counts category blocks, membership and member numbers per group and range', () => {
    const rows = qActivityStats({ groupJids: A }, {
      ranges: [{ from: 0, to: 100_000 }],
      categories: new Set(['primary', 'corrective', 'secondary'] as const),
    })
    expect(rows.length).toBe(1)
    const r = rows[0]
    expect(r.groupJid).toBe('a@g.us')
    // primary: messages M1,M2,M3,M4,M7,M8,M9,M10 = 8; polls 1; events 1
    expect(r.counts.primary).toEqual({ messages: 8, polls: 1, events: 1 })
    // corrective: edits 1; own_deletes 1 (M8); admin delete of M7 not counted here
    expect(r.counts.corrective).toEqual({ edits: 1, own_deletes: 1 })
    expect(r.counts.secondary).toEqual({ reactions: 1, poll_votes: 2, event_responses: 1 })
    expect(r.members!.contributors).toBe(3)
    expect(r.members!.engagers).toBe(3) // Anna reacted, Boris voted+responded, Carl voted
    expect(r.members!.joined).toBe(1)
    expect(r.members!.left).toBe(1)
    expect(r.members!.total).toBe(3)
  })

  it('adds a distinct-person total row when covering several groups', () => {
    const rows = qActivityStats({ groupJids: AB }, {
      ranges: [{ from: 0, to: 100_000 }],
      categories: new Set(['primary'] as const),
    })
    expect(rows.map(r => r.groupJid)).toEqual(['a@g.us', 'b@g.us', 'total'])
    const total = rows[2]
    expect(total.counts.primary!.messages).toBe(9) // 8 + 1
    expect(total.members!.contributors).toBe(3) // Anna posts in both groups but counts once
  })

  it('respects ranges and the participant filter', () => {
    const rows = qActivityStats({ groupJids: A }, {
      ranges: [{ from: 0, to: 2500 }, { from: 4900, to: 6500 }],
      categories: new Set(['primary', 'secondary'] as const),
      participantLids: [BORIS],
    })
    expect(rows.length).toBe(2)
    expect(rows[0].counts.primary).toEqual({ messages: 1, polls: 0, events: 0 }) // M2
    expect(rows[0].counts.secondary).toEqual({ reactions: 0, poll_votes: 0, event_responses: 0 })
    expect(rows[1].counts.secondary).toEqual({ reactions: 0, poll_votes: 1, event_responses: 1 })
  })
})

describe('qSearchMessages', () => {
  it('finds AND-word matches and resolves edits to their message', () => {
    const { hits, total } = qSearchMessages({ groupJids: A }, { query: ['picnic plan'], from: 0, to: 100_000, order: 'desc', limit: 20, offset: 0 })
    expect(total).toBe(1)
    expect(hits[0].messageId).toBe('M2') // hit may come from the edit row, resolved to M2
    expect(hits[0].snippet).toContain('picnic')
  })

  it('supports OR alternatives and phrases', () => {
    const { hits } = qSearchMessages({ groupJids: AB }, { query: ['"beta chatter"', 'hello'], from: 0, to: 100_000, order: 'asc', limit: 20, offset: 0 })
    expect(hits.map(h => h.messageId)).toEqual(['M1', 'B1'])
  })

  it('filters by author and date range', () => {
    const { hits } = qSearchMessages({ groupJids: AB }, { query: ['chatter'], authorLid: ANNA, from: 0, to: 100_000, order: 'desc', limit: 20, offset: 0 })
    expect(hits.map(h => h.messageId)).toEqual(['B1'])
    expect(qSearchMessages({ groupJids: AB }, { query: ['chatter'], from: 0, to: 8000, order: 'desc', limit: 20, offset: 0 }).total).toBe(0)
  })
})
