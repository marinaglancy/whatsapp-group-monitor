import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedMember, seedMessage, seedTenant, seedSpamTrigger } from '../helpers/fixtures.js'
import { getAccountDb } from '../../src/db/account.js'
import { groupMembers } from '../../src/db/schema.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { getJob } from '../../src/db/queries/jobs.js'
import { dispatchEvent } from '../../src/triggers/dispatcher.js'
import { registerBuiltinTriggerTypes } from '../../src/triggers/index.js'
import { clearTriggerTypesForTests, getTriggerType } from '../../src/triggers/registry.js'
import { spamTriggerType, SPAM_REGEX_MAX, SPAM_TEXT_SCAN_MAX, type SpamTriggerConfig } from '../../src/triggers/spam/type.js'
import { hasLink } from '../../src/utils/text.js'
import { SPAM_EDIT_WINDOW_MS, SPAM_REUSE_WINDOW_MS } from '../../src/triggers/spam/defaults.js'
import type { TriggerEvent } from '../../src/triggers/types.js'

const BOT_JID = '15550001234@s.whatsapp.net'
const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000

let dbs: ReturnType<typeof setupTestDbs>
let tenantId: number
beforeEach(() => {
  dbs = setupTestDbs()
  updateBotUser({ id: BOT_JID } as never)
  clearTriggerTypesForTests()
  registerBuiltinTriggerTypes()
  seedGroup('a@g.us', 'A', { botMembership: 'admin' })
  seedGroup('b@g.us', 'B', { botMembership: 'participant' })
  seedGroup('rep@g.us', 'Reports')
  tenantId = seedTenant('T', ['a@g.us', 'b@g.us', 'rep@g.us'])
})
afterEach(() => { dbs.cleanup() })

function record(over: Record<string, unknown> = {}) {
  return {
    groupJid: 'a@g.us', userJid: 'spammer@lid', messageId: `S${Math.random()}`, parentId: null,
    eventType: 'message' as const, metadata: { contentType: 'conversation', text: 'buy at https://x.y' },
    timestamp: NOW_S - 1, ...over,
  } as never
}
const ev = (r: never): TriggerEvent => ({ kind: 'group_message', record: r })
const run = (r: never) => dispatchEvent(ev(r), NOW_MS)
const cfg = (over: Partial<SpamTriggerConfig> = {}): SpamTriggerConfig => ({ ...spamTriggerType.defaults(), reportGroupJid: 'rep@g.us', ...over })

describe('hasLink', () => {
  it('detects links', () => {
    expect(hasLink('https://x.y')).toBe(true)
    expect(hasLink('see www.x.y now')).toBe(true)
    expect(hasLink('bit.ly/abc')).toBe(true)
    expect(hasLink('chat.whatsapp.com/Abc')).toBe(true)
  })
  it('ignores plain text', () => {
    for (const t of ['e.g. this', 'i.e. that', 'photo.jpg', 'Mr.Smith', 'Awww. so cute', '5.30.', 'see you at 5.30']) {
      expect(hasLink(t)).toBe(false)
    }
    expect(hasLink('hello world. Bye')).toBe(false)
  })
})

describe('hasLink speed', () => {
  it('checks very long messages quickly', () => {
    for (const t of ['a'.repeat(65_000), 'a.'.repeat(32_000)]) {
      const start = performance.now()
      hasLink(t)
      expect(performance.now() - start).toBeLessThan(50)
    }
  })
})

describe('Spam trigger type', () => {
  it('is registered with its ids', () => {
    expect(getTriggerType('spam')).toBe(spamTriggerType)
    expect(spamTriggerType.displayName).toBe('Spam')
    expect(spamTriggerType.jobType).toBe('spam_check')
    expect(SPAM_EDIT_WINDOW_MS).toBe(840_000)
    expect(SPAM_REUSE_WINDOW_MS).toBe(900_000)
    expect(spamTriggerType.defaultErrorTemplate).toBe('⚠️ Spam check failed for a message by {{user}} in {{group}}: {{error}}')
    // values the sender writes or chooses stay out of the default instructions (they are in the user's turn)
    for (const p of ['{{group}}', '{{user}}', '{{message}}']) expect(spamTriggerType.defaultPrompt).not.toContain(p)
  })

  it('dispatches a spam_check job with the wait as runAt', () => {
    seedSpamTrigger(tenantId, 'rep@g.us')
    const ids = run(record())
    expect(ids).toHaveLength(1)
    const job = getJob(ids[0])!
    expect(job.jobType).toBe('spam_check')
    expect(job.runAt).toBe(NOW_S + 10)
    expect(job.payload).toEqual({ text: 'buy at https://x.y', contentType: 'conversation' })
  })

  it('does not fire for plain text, reactions, or admins', () => {
    seedSpamTrigger(tenantId, 'rep@g.us')
    expect(run(record({ metadata: { contentType: 'conversation', text: 'hi all' } }))).toEqual([])
    expect(run(record({ eventType: 'reaction' }))).toEqual([])
    seedMember('a@g.us', 'spammer@lid', 'admin')
    expect(run(record())).toEqual([])
  })

  it('fires for an image without text when "it has an image" is ticked', () => {
    seedSpamTrigger(tenantId, 'rep@g.us', { config: { contentImage: true } })
    expect(run(record({ metadata: { contentType: 'imageMessage' } }))).toHaveLength(1)
  })

  it('by default ignores an image without text (pictures are not analysed)', () => {
    seedSpamTrigger(tenantId, 'rep@g.us')
    expect(run(record({ metadata: { contentType: 'imageMessage' } }))).toHaveLength(0)
  })

  it('content off fires on every message; image unticked ignores images', () => {
    seedSpamTrigger(tenantId, 'rep@g.us', { config: { contentEnabled: false } })
    expect(run(record({ metadata: { text: 'hello' } }))).toHaveLength(1)
  })

  it('regex is case-insensitive and any ticked option is enough', () => {
    seedSpamTrigger(tenantId, 'rep@g.us', { config: { contentLink: false, contentImage: false, contentRegex: 'free\\s+crypto' } })
    expect(run(record({ metadata: { text: 'Get FREE   Crypto now' } }))).toHaveLength(1)
    expect(run(record({ metadata: { text: 'https://x.y' } }))).toEqual([])
  })

  it('the regex only sees the first 4000 characters', () => {
    seedSpamTrigger(tenantId, 'rep@g.us', { config: { contentLink: false, contentImage: false, contentRegex: 'needle' } })
    expect(run(record({ metadata: { text: 'a'.repeat(SPAM_TEXT_SCAN_MAX - 6) + 'needle' } }))).toHaveLength(1)
    expect(run(record({ metadata: { text: 'a'.repeat(SPAM_TEXT_SCAN_MAX - 5) + 'needle' } }))).toEqual([])
  })

  it('an invalid or too long stored regex never throws or matches', () => {
    seedSpamTrigger(tenantId, 'rep@g.us', { config: { contentLink: false, contentImage: false, contentRegex: '(' } })
    expect(run(record({ metadata: { text: 'aaa (' } }))).toEqual([])
    seedSpamTrigger(tenantId, 'rep@g.us', { config: { contentLink: false, contentImage: false, contentRegex: 'a'.repeat(SPAM_REGEX_MAX + 1) } })
    expect(run(record({ metadata: { text: 'a'.repeat(300) } }))).toEqual([])
  })

  it('watches by groups mode', () => {
    const e = (g: string) => ev(record({ groupJid: g }))
    expect(spamTriggerType.watches(e('a@g.us'), cfg())).toBe(true)
    expect(spamTriggerType.watches(e('a@g.us'), cfg({ groupsMode: 'only', groupJids: ['a@g.us'] }))).toBe(true)
    expect(spamTriggerType.watches(e('b@g.us'), cfg({ groupsMode: 'only', groupJids: ['a@g.us'] }))).toBe(false)
    expect(spamTriggerType.watches(e('a@g.us'), cfg({ groupsMode: 'except', groupJids: ['a@g.us'] }))).toBe(false)
    expect(spamTriggerType.watches(e('b@g.us'), cfg({ groupsMode: 'except', groupJids: ['a@g.us'] }))).toBe(true)
  })

  it('never watches its own notification group', () => {
    const e = (g: string) => ev(record({ groupJid: g }))
    expect(spamTriggerType.watches(e('rep@g.us'), cfg())).toBe(false)
    expect(spamTriggerType.watches(e('rep@g.us'), cfg({ groupsMode: 'only', groupJids: ['rep@g.us'] }))).toBe(false)
    expect(spamTriggerType.watches(e('a@g.us'), cfg({ reportGroupJid: 'a@g.us' }))).toBe(false)
    expect(spamTriggerType.watches(e('rep@g.us'), cfg({ reportGroupJid: 'a@g.us' }))).toBe(true)
    // the dispatcher makes no job for a message there
    seedSpamTrigger(tenantId, 'rep@g.us')
    expect(run(record({ groupJid: 'rep@g.us' }))).toEqual([])
    expect(run(record({ groupJid: 'b@g.us' }))).toHaveLength(1)
  })

  it('watches by bot role (admin includes superadmin)', () => {
    const e = (g: string) => ev(record({ groupJid: g }))
    expect(spamTriggerType.watches(e('a@g.us'), cfg({ botRole: 'admin' }))).toBe(true)
    expect(spamTriggerType.watches(e('b@g.us'), cfg({ botRole: 'admin' }))).toBe(false)
    expect(spamTriggerType.watches(e('a@g.us'), cfg({ botRole: 'not_admin' }))).toBe(false)
    expect(spamTriggerType.watches(e('b@g.us'), cfg({ botRole: 'not_admin' }))).toBe(true)
    seedGroup('s@g.us', 'S', { botMembership: 'superadmin' })
    expect(spamTriggerType.watches(e('s@g.us'), cfg({ botRole: 'admin' }))).toBe(true)
  })

  it('applies joined-within and message-count conditions', () => {
    seedSpamTrigger(tenantId, 'rep@g.us', { config: { joinedWithinDays: 7, maxMessages: 3 } })
    expect(run(record())).toEqual([]) // join date unknown
    seedMember('a@g.us', 'spammer@lid')
    expect(run(record())).toEqual([]) // seeded members have no join date -> old
    getAccountDb().update(groupMembers).set({ joinedAt: new Date(NOW_MS - 86_400_000) }).run()
    expect(run(record())).toHaveLength(1)
    seedMessage('a@g.us', 'spammer@lid', 'one', NOW_S - 100)
    seedMessage('a@g.us', 'spammer@lid', 'two', NOW_S - 90)
    seedMessage('a@g.us', 'spammer@lid', 'three', NOW_S - 80)
    expect(run(record())).toEqual([]) // already 3 earlier messages
  })

  it('validate accepts the defaults with a report group', () => {
    const ctx = { coveredGroupJids: ['a@g.us', 'rep@g.us'] }
    expect(spamTriggerType.validate({ reportGroupJid: 'rep@g.us' }, ctx).ok).toBe(true)
  })

  it('validate rejects bad settings', () => {
    const ctx = { coveredGroupJids: ['a@g.us', 'rep@g.us'] }
    const ok = (over: Record<string, unknown>) => spamTriggerType.validate({ reportGroupJid: 'rep@g.us', ...over }, ctx).ok
    expect(spamTriggerType.validate({}, ctx).ok).toBe(false)
    expect(ok({ reportGroupJid: 'x@g.us' })).toBe(false)
    expect(ok({ groupsMode: 'only', groupJids: [] })).toBe(false)
    expect(ok({ groupsMode: 'only', groupJids: ['a@g.us'] })).toBe(true)
    expect(ok({ groupsMode: 'only', groupJids: ['zzz@g.us'] })).toBe(false)
    expect(ok({ groupsMode: 'some' })).toBe(false)
    expect(ok({ botRole: 'boss' })).toBe(false)
    expect(ok({ waitSeconds: -1 })).toBe(false)
    expect(ok({ waitSeconds: 3601 })).toBe(false)
    expect(ok({ maxAgeMinutes: 0 })).toBe(false)
    expect(ok({ maxAgeMinutes: 1441 })).toBe(false)
    expect(ok({ waitSeconds: 60, maxAgeMinutes: 1 })).toBe(false)
    expect(ok({ joinedWithinDays: 0 })).toBe(false)
    expect(ok({ joinedWithinDays: 3651 })).toBe(false)
    expect(ok({ joinedWithinDays: 30 })).toBe(true)
    expect(ok({ maxMessages: 0 })).toBe(false)
    expect(ok({ maxMessages: 10_001 })).toBe(false)
    expect(ok({ maxMessages: 5 })).toBe(true)
    expect(ok({ contentLink: false, contentImage: false })).toBe(false)
    expect(ok({ contentEnabled: false, contentLink: false, contentImage: false })).toBe(true)
    expect(ok({ prompt: 'x'.repeat(20_001) })).toBe(false)
    expect(ok({ instructions: 'x'.repeat(4_001) })).toBe(false)
    expect(ok({ errorTemplate: 'x'.repeat(1_001) })).toBe(false)
  })

  it('validate refuses a regex over 200 characters and an invalid regex', () => {
    const ctx = { coveredGroupJids: ['rep@g.us'] }
    const ok = (contentRegex: string) => spamTriggerType.validate({ reportGroupJid: 'rep@g.us', contentRegex }, ctx).ok
    expect(ok('a'.repeat(SPAM_REGEX_MAX))).toBe(true)
    expect(ok('a'.repeat(SPAM_REGEX_MAX + 1))).toBe(false)
    expect(ok('(')).toBe(false)
    expect(ok('[a-')).toBe(false)
  })

  it('validate refuses a repeated group that already repeats', () => {
    const ctx = { coveredGroupJids: ['rep@g.us'] }
    const ok = (contentRegex: string) => spamTriggerType.validate({ reportGroupJid: 'rep@g.us', contentRegex }, ctx).ok
    for (const p of ['(a+)+$', '(\\w*)*', '(x+){2,}']) expect(ok(p)).toBe(false)
    for (const p of ['(spam|scam)', '\\d+', '(abc)+']) expect(ok(p)).toBe(true)
  })

  it('has the three actions off by default, and refuses a value that is not true or false', () => {
    const ctx = { coveredGroupJids: ['rep@g.us'] }
    expect(spamTriggerType.defaults()).toMatchObject({ deleteSpammerCopies: false, removeSpammer: false, deleteSuspicious: false })
    // a trigger saved before the actions existed has them off
    expect(spamTriggerType.normalize({ reportGroupJid: 'rep@g.us' }))
      .toMatchObject({ deleteSpammerCopies: false, removeSpammer: false, deleteSuspicious: false })
    const result = (over: Record<string, unknown>) => spamTriggerType.validate({ reportGroupJid: 'rep@g.us', ...over }, ctx)
    expect(result({ deleteSpammerCopies: true, removeSpammer: true, deleteSuspicious: true })).toMatchObject({
      ok: true, config: { deleteSpammerCopies: true, removeSpammer: true, deleteSuspicious: true },
    })
    expect(result({ deleteSpammerCopies: 'yes' })).toEqual({ ok: false, error: 'Invalid setting: deleteSpammerCopies' })
    expect(result({ removeSpammer: 1 })).toEqual({ ok: false, error: 'Invalid setting: removeSpammer' })
    expect(result({ deleteSuspicious: null })).toEqual({ ok: false, error: 'Invalid setting: deleteSuspicious' })
  })

  it('normalize fills the defaults', () => {
    const c = spamTriggerType.normalize({ reportGroupJid: 'rep@g.us', waitSeconds: 3, junk: 1 })
    expect(c).toMatchObject({ groupsMode: 'all', botRole: 'any', contentLink: true, contentImage: false, contentRegex: '',
      senderNotAdmin: true, joinedWithinDays: null, maxMessages: null, waitSeconds: 3, maxAgeMinutes: 60, onlyIfFirst: false })
    expect(c).not.toHaveProperty('junk')
  })

  it('summarize and warning', () => {
    const name = (j: string) => (j === 'rep@g.us' ? 'Reports' : j)
    expect(spamTriggerType.summarize(cfg({ waitSeconds: 0 }), name)).toBe('all groups · reports to Reports')
    expect(spamTriggerType.summarize(cfg({ groupsMode: 'except', groupJids: ['a@g.us', 'b@g.us'], botRole: 'admin' }), name))
      .toBe('except 2 groups · reports to Reports · admin groups only · wait 10 s')
    expect(spamTriggerType.summarize(cfg({ waitSeconds: 0, deleteSpammerCopies: true, removeSpammer: true }), name))
      .toBe('all groups · reports to Reports · deletes spam · removes spammers')
    expect(spamTriggerType.summarize(cfg({ waitSeconds: 0, deleteSuspicious: true }), name))
      .toBe('all groups · reports to Reports · deletes suspicious messages')
    expect(spamTriggerType.warning(cfg(), ['rep@g.us'])).toBeNull()
    expect(spamTriggerType.warning(cfg({ reportGroupJid: '' }), ['rep@g.us'])).toBe('Choose a notification group in this tenant')
    expect(spamTriggerType.warning(cfg(), ['a@g.us'])).toBe('Choose a notification group in this tenant')
  })
})
