import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Ajv, { type ValidateFunction } from 'ajv'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMember, seedMessage } from '../helpers/fixtures.js'
import { updateGroupQaConfig } from '../../src/db/queries/groups.js'
import { resolveQaScope } from '../../src/bot/scope.js'
import { rawToolDeclarations } from '../../src/ai/tools/loader.js'
import { executeQaTool, toolExecutorNames, TOOL_RESULT_MAX_BYTES } from '../../src/ai/tools/executors.js'

const ANNA = 'anna@lid'
const BORIS = 'boris@lid'

const ajv = new Ajv({ strict: false })
const validators = new Map<string, ValidateFunction>()
for (const t of rawToolDeclarations()) {
  validators.set(t.name, ajv.compile(t.responseJsonSchema as object))
}

function run(name: string, args: Record<string, unknown>, ctx: Parameters<typeof executeQaTool>[2]) {
  const { result } = executeQaTool(name, args, ctx)
  const parsed = JSON.parse(result)
  if (!('error' in parsed)) {
    const validate = validators.get(name)!
    const ok = validate(parsed)
    if (!ok) throw new Error(`${name} output violates its responseJsonSchema: ${JSON.stringify(validate.errors)}`)
  }
  return parsed
}

let dbs: ReturnType<typeof setupTestDbs>
let ctx: { scope: ReturnType<typeof resolveQaScope>; timezone: string }

beforeEach(() => {
  dbs = setupTestDbs()
  seedGroup('qa@g.us', 'Admins')
  seedGroup('comm@g.us', 'Hive', { isCommunity: true })
  seedGroup('a@g.us', 'Alpha', { parentCommunityJid: 'comm@g.us', botMembership: 'admin' })
  seedGroup('b@g.us', 'Beta', { parentCommunityJid: 'comm@g.us' })
  seedGroup('outside@g.us', 'Outside')
  seedUser(ANNA, 'Anna', '351911111111')
  seedUser(BORIS, 'Boris')
  seedMember('a@g.us', ANNA, 'admin')
  seedMember('a@g.us', BORIS)
  seedMember('b@g.us', ANNA)
  // timestamps around 2026-09-15 12:00:00 UTC = 1789473600
  const T = 1789473600
  seedMessage('a@g.us', ANNA, 'hello world picnic', T, { messageId: 'M1' })
  seedMessage('a@g.us', BORIS, 'short', T + 60, { messageId: 'M2', parentId: 'M1', metadata: { contentType: 'conversation', text: 'short', isReply: true } })
  seedMessage('a@g.us', ANNA, '', T + 120, { eventType: 'reaction', parentId: 'M2', metadata: { emoji: '🔥' } })
  seedMessage('outside@g.us', ANNA, 'secret text', T)
  updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['comm@g.us'] })
  ctx = { scope: resolveQaScope('qa@g.us'), timezone: 'UTC' }
})
afterEach(() => { dbs.cleanup() })

describe('executor registry', () => {
  it('matches the declarations 1:1', () => {
    expect(toolExecutorNames().sort()).toEqual(rawToolDeclarations().map(t => t.name).sort())
  })

  it('returns an error for unknown tools', () => {
    expect(run('drop_tables', {}, ctx).error).toMatch(/unknown tool/i)
  })
})

describe('group_list', () => {
  it('lists scope groups and communities with requested fields', () => {
    const out = run('group_list', { fields: ['is_community', 'parent_jid', 'member_count', 'bot_role', 'last_activity'] }, ctx)
    const names = out.groups.map((g: { name: string }) => g.name).sort()
    expect(names).toEqual(['Admins', 'Alpha', 'Beta', 'Hive']) // the QA group itself is always in scope
    const alpha = out.groups.find((g: { jid: string }) => g.jid === 'a@g.us')
    expect(alpha.member_count).toBe(2)
    expect(alpha.bot_role).toBe('admin')
    expect(alpha.parent_jid).toBe('comm@g.us')
    expect(alpha.last_activity).toMatch(/^2026-09-15 \d{2}:\d{2}:\d{2}$/)
    const hive = out.groups.find((g: { jid: string }) => g.jid === 'comm@g.us')
    expect(hive.is_community).toBe(true)
    expect(out.total).toBe(4)
    expect(out.has_more).toBe(false)
  })

  it('returns only jid and name when fields are omitted', () => {
    const out = run('group_list', {}, ctx)
    expect(Object.keys(out.groups[0]).sort()).toEqual(['jid', 'name'])
  })

  it('rejects out-of-scope jids without leaking data', () => {
    const out = run('group_list', { group_jids: ['outside@g.us'] }, ctx)
    expect(out.error).toMatch(/not in scope/i)
    expect(JSON.stringify(out)).not.toContain('secret')
  })
})

describe('group_members', () => {
  it('returns members with datetimes formatted and no epoch numbers', () => {
    const out = run('group_members', { activity_from: '2026-09-15', activity_to: '2026-09-16' }, ctx)
    expect(out.total).toBe(2)
    const anna = out.members.find((m: { lid: string }) => m.lid === ANNA)
    expect(anna.name).toBe('Anna')
    expect(anna.activity_count).toBe(2) // M1 + reaction
    expect(anna.last_activity).toMatch(/^2026-09-15 /)
  })

  it('rejects inverted date ranges', () => {
    const out = run('group_members', { activity_from: '2026-09-16', activity_to: '2026-09-15' }, ctx)
    expect(out.error).toMatch(/from.*to/i)
  })

  it('rejects non-numeric count filters instead of returning silent zeros', () => {
    const out = run('group_members', { min_activity_count: 'abc' }, ctx)
    expect(out.error).toMatch(/min_activity_count/i)
  })

  it('treats an empty fields array like an omitted one', () => {
    const out = run('group_members', { fields: [], activity_from: '2026-09-15', activity_to: '2026-09-16' }, ctx)
    expect(out.members[0].activity_count).toBeDefined()
  })

  it('accepts bare-digit person references from person strings (lid or phone)', () => {
    // person strings emit '<lid digits> <phone> <name>' — those digits must be usable as filters
    const byBare = run('group_messages', { from: '2026-09-15', to: '2026-09-15', member_lid: 'anna' }, ctx)
    expect(byBare.total).toBe(2) // authored M1, reacted to M2
    const byPhone = run('group_messages', { from: '2026-09-15', to: '2026-09-15', member_lid: '351911111111' }, ctx)
    expect(byPhone.total).toBe(2)
    const unknown = run('group_messages', { from: '2026-09-15', to: '2026-09-15', member_lid: 'nosuch' }, ctx)
    expect(unknown.error).toMatch(/unknown member/i)
  })

  it('accepts bare-digit participant_lids in stats', () => {
    const out = run('activity_stats', { ranges: [{ from: '2026-09-15', to: '2026-09-15' }], participant_lids: ['anna'] }, ctx)
    const alpha = out.rows.find((r: { group_jid: string }) => r.group_jid === 'a@g.us')
    expect(alpha.counts.primary.messages).toBe(1)
  })
})

describe('group_messages', () => {
  it('returns the resolved view with person-string reactions', () => {
    const out = run('group_messages', { from: '2026-09-15', to: '2026-09-15' }, ctx)
    expect(out.total).toBe(2)
    const m2 = out.messages.find((m: { id: string }) => m.id === 'M2')
    expect(m2.reply_to_id).toBe('M1')
    expect(m2.reactions).toEqual([{ emoji: '🔥', by: ['anna 351911111111 Anna'] }])
    expect(m2.author).toEqual({ lid: BORIS, name: 'Boris' })
  })

  it('shrinks pages adaptively and reports next_offset', () => {
    const big = 'x'.repeat(2000)
    for (let i = 0; i < 40; i++) seedMessage('b@g.us', ANNA, `${big} ${i}`, 1789474000 + i)
    const out = run('group_messages', { group_jids: ['b@g.us'], from: '2026-09-15', to: '2026-09-16', limit: 40 }, ctx)
    expect(out.messages.length).toBeLessThan(40)
    expect(out.has_more).toBe(true)
    expect(out.next_offset).toBe(out.messages.length)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES)
    // continuation picks up exactly where the page ended
    const next = run('group_messages', { group_jids: ['b@g.us'], from: '2026-09-15', to: '2026-09-16', limit: 40, offset: out.next_offset }, ctx)
    expect(next.messages[0].text).toContain(` ${out.messages.length}`)
  })

  it('errors when a single row cannot fit the byte budget', () => {
    seedMessage('b@g.us', ANNA, 'y'.repeat(40_000), 1789475000)
    const out = run('group_messages', { group_jids: ['b@g.us'], from: '2026-09-15', to: '2026-09-16' }, ctx)
    expect(out.error).toMatch(/maximum allowed is 32000/)
  })
})

describe('activity_stats', () => {
  it('produces category blocks, members and the total row with formatted ranges', () => {
    const out = run('activity_stats', { ranges: [{ from: '2026-09-15', to: '2026-09-15' }] }, ctx)
    expect(out.rows.map((r: { group_jid: string }) => r.group_jid)).toEqual(['qa@g.us', 'a@g.us', 'b@g.us', 'total'])
    const a = out.rows[1]
    expect(a.group_name).toBe('Alpha')
    expect(a.range).toEqual({ from: '2026-09-15 00:00:00', to: '2026-09-15 23:59:59' })
    expect(a.counts.primary.messages).toBe(2)
    expect(a.counts.secondary.reactions).toBe(1)
    expect(a.members.contributors).toBe(2)
    expect(a.members.engagers).toBe(2) // funnel: posting counts as engagement
    expect(a.members.total).toBe(2)
  })

  it('omits members when filtering by a single participant', () => {
    const out = run('activity_stats', { ranges: [{ from: '2026-09-15', to: '2026-09-15' }], participant_lids: [ANNA] }, ctx)
    const alpha = out.rows.find((r: { group_jid: string }) => r.group_jid === 'a@g.us')
    expect(alpha.members).toBeUndefined()
    expect(alpha.counts.primary.messages).toBe(1)
  })

  it('rejects more than 12 ranges', () => {
    const ranges = Array.from({ length: 13 }, () => ({ from: '2026-09-01', to: '2026-09-02' }))
    expect(run('activity_stats', { ranges }, ctx).error).toMatch(/ranges/i)
  })
})

describe('message_search', () => {
  it('searches within scope and formats hits', () => {
    const out = run('message_search', { query: ['picnic'] }, ctx)
    expect(out.total).toBe(1)
    expect(out.hits[0].id).toBe('M1')
    expect(out.hits[0].group_name).toBe('Alpha')
    expect(out.hits[0].author).toEqual({ lid: ANNA, name: 'Anna' })
    expect(out.hits[0].type).toBe('message')
    expect(out.hits[0].sent_at).toMatch(/^2026-09-15 /)
    expect(run('message_search', { query: ['secret'] }, ctx).total).toBe(0)
  })

  it('requires a non-empty query', () => {
    expect(run('message_search', { query: [] }, ctx).error).toMatch(/query/i)
    expect(run('message_search', {}, ctx).error).toMatch(/query/i)
  })
})
