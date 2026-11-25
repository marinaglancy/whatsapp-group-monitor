import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedMessage, seedTenant, seedQaTrigger } from '../helpers/fixtures.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { registerSentMessage } from '../../src/bot/sent-registry.js'
import { getJob, insertJob, addJobEvent, listJobs } from '../../src/db/queries/jobs.js'
import { dispatchEvent } from '../../src/triggers/dispatcher.js'
import { registerBuiltinTriggerTypes } from '../../src/triggers/index.js'
import { clearTriggerTypesForTests } from '../../src/triggers/registry.js'
import { qaTriggerType } from '../../src/triggers/qa/type.js'
import { QA_INSTRUCTIONS_MAX } from '../../src/triggers/qa/defaults.js'
import type { TriggerEvent } from '../../src/triggers/types.js'
import { processRecord } from '../../src/whatsapp/activity/processor.js'

const BOT_JID = '15550001234@s.whatsapp.net'
const BOT_LID = '98765432101234@lid'
const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000

let dbs: ReturnType<typeof setupTestDbs>
let tenantId: number
beforeEach(() => {
  dbs = setupTestDbs()
  updateBotUser({ id: BOT_JID, lid: BOT_LID } as never)
  clearTriggerTypesForTests()
  registerBuiltinTriggerTypes()
  seedGroup('qa@g.us', 'Admins')
  seedGroup('other@g.us', 'Other')
  tenantId = seedTenant('T', ['qa@g.us', 'other@g.us'])
  seedQaTrigger(tenantId, 'qa@g.us')
})
afterEach(() => { dbs.cleanup() })

function record(over: Record<string, unknown> = {}) {
  return {
    groupJid: 'qa@g.us',
    userJid: 'asker@s.whatsapp.net',
    messageId: `Q${Math.random()}`,
    parentId: null,
    eventType: 'message' as const,
    metadata: { contentType: 'conversation', text: 'how many messages?', mentions: [BOT_JID] },
    timestamp: NOW_S - 5,
    ...over,
  } as never
}
const ev = (r: never): TriggerEvent => ({ kind: 'group_message', record: r })
const run = (r: never) => dispatchEvent(ev(r), NOW_MS)

describe('Q&A trigger type', () => {
  it('enqueues on @mention of the bot phone jid', () => {
    const ids = run(record())
    expect(ids).toHaveLength(1)
    const job = getJob(ids[0])!
    expect(job.jobType).toBe('qa_answer')
    expect(job.payload).toEqual({ text: 'how many messages?' })
    expect(job.expiresAt).toBe(NOW_S - 5 + 600)
  })

  it('enqueues on @mention of the bot LID', () => {
    expect(run(record({ metadata: { text: 'hi', mentions: [BOT_LID] } }))).toHaveLength(1)
  })

  it('ignores mentions of other members', () => {
    expect(run(record({ metadata: { text: 'hi', mentions: ['somebody@s.whatsapp.net'] } }))).toEqual([])
  })

  it('enqueues on a reply to a bot message with quotedBotMessageId in payload', () => {
    seedMessage('qa@g.us', BOT_LID, 'earlier answer', NOW_S - 60, { messageId: 'BOTMSG' })
    const ids = run(record({ parentId: 'BOTMSG', metadata: { text: 'and for August?' } }))
    expect(ids).toHaveLength(1)
    expect(getJob(ids[0])!.payload).toEqual({ text: 'and for August?', quotedBotMessageId: 'BOTMSG' })
  })

  it('links a follow-up to the job that produced the quoted answer', () => {
    seedMessage('qa@g.us', BOT_LID, 'earlier answer', NOW_S - 60, { messageId: 'BOTMSG' })
    const parentId = insertJob({
      jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@s.whatsapp.net', messageId: 'Q0',
      payload: { text: 'q0' }, runAt: NOW_S - 70, expiresAt: NOW_S + 600,
    })!
    addJobEvent(parentId, 'reply_sent', { groupJid: 'qa@g.us', messageId: 'BOTMSG' })
    const ids = run(record({ parentId: 'BOTMSG', metadata: { text: 'and more?' } }))
    expect(getJob(ids[0])!.payload).toEqual({ text: 'and more?', quotedBotMessageId: 'BOTMSG', parentJobId: parentId })
  })

  it('ignores replies to non-bot messages', () => {
    seedMessage('qa@g.us', 'human@s.whatsapp.net', 'some msg', NOW_S - 60, { messageId: 'HUMANMSG' })
    expect(run(record({ parentId: 'HUMANMSG', metadata: { text: 'ok' } }))).toEqual([])
  })

  it('ignores messages the bot itself sent', () => {
    const rec = record()
    registerSentMessage((rec as { messageId: string }).messageId)
    expect(run(rec)).toEqual([])
  })

  it('ignores stale messages (default 10 minutes)', () => {
    expect(run(record({ timestamp: NOW_S - 601 }))).toEqual([])
    expect(run(record({ timestamp: NOW_S - 599 }))).toHaveLength(1)
  })

  it('ignores non-message events and empty text', () => {
    expect(run(record({ eventType: 'reaction' }))).toEqual([])
    expect(run(record({ metadata: { mentions: [BOT_JID] } }))).toEqual([])
    expect(run(record({ metadata: { text: '   ', mentions: [BOT_JID] } }))).toEqual([])
  })

  it('never enqueues the same message twice', () => {
    const rec = record({ messageId: 'SAME' })
    expect(run(rec)).toHaveLength(1)
    expect(run(rec)).toEqual([])
  })

  it('only answers in its own Q&A group, not in other tenant groups', () => {
    expect(run(record({ groupJid: 'other@g.us' }))).toEqual([])
  })

  it('two Q&A triggers on the same group both create a job', () => {
    seedQaTrigger(tenantId, 'qa@g.us', { name: 'Second' })
    expect(run(record())).toHaveLength(2)
  })

  it('validate rejects a Q&A group outside the tenant and out-of-range numbers', () => {
    const ctx = { coveredGroupJids: ['qa@g.us'] }
    const ok = (over: Record<string, unknown>) => qaTriggerType.validate({ qaGroupJid: 'qa@g.us', ...over }, ctx).ok
    expect(ok({})).toBe(true)
    expect(qaTriggerType.validate({ qaGroupJid: 'nope@g.us' }, ctx).ok).toBe(false)
    expect(qaTriggerType.validate({}, ctx).ok).toBe(false)
    expect(ok({ waitSeconds: -1 })).toBe(false)
    expect(ok({ waitSeconds: 3601 })).toBe(false)
    expect(ok({ waitSeconds: 1.5 })).toBe(false)
    expect(ok({ maxAgeMinutes: 0 })).toBe(false)
    expect(ok({ maxAgeMinutes: 1441 })).toBe(false)
    expect(ok({ instructions: 'x'.repeat(QA_INSTRUCTIONS_MAX + 1) })).toBe(false)
    expect(ok({ prompt: 'x'.repeat(20_001) })).toBe(false)
    expect(ok({ errorTemplate: 'x'.repeat(1_001) })).toBe(false)
    expect(ok({ onlyIfFirst: 'yes' })).toBe(false)
  })

  it('normalize fills defaults and drops unknown keys', () => {
    const c = qaTriggerType.normalize({ qaGroupJid: 'qa@g.us', waitSeconds: 5, junk: 1 })
    expect(c).toEqual({ ...qaTriggerType.defaults(), qaGroupJid: 'qa@g.us', waitSeconds: 5 })
    expect(c).not.toHaveProperty('junk')
  })

  it('processRecord enqueues through the triggers', () => {
    const now = Math.floor(Date.now() / 1000)
    processRecord(record({ timestamp: now - 1 }))
    expect(listJobs({ jobType: 'qa_answer', limit: 10, offset: 0 }).jobs).toHaveLength(1)
  })
})

describe('qa validate: wait versus age limit', () => {
  it('rejects a wait that is not shorter than the age limit', () => {
    const res = qaTriggerType.validate(
      { qaGroupJid: 'qa@g.us', waitSeconds: 600, maxAgeMinutes: 10 },
      { coveredGroupJids: ['qa@g.us'] },
    )
    expect(res).toEqual({ ok: false, error: 'The wait must be shorter than the age limit.' })
    expect(qaTriggerType.validate(
      { qaGroupJid: 'qa@g.us', waitSeconds: 599, maxAgeMinutes: 10 },
      { coveredGroupJids: ['qa@g.us'] },
    ).ok).toBe(true)
  })
})
