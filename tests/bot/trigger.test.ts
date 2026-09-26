import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedMessage } from '../helpers/fixtures.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { updateGroupQaConfig } from '../../src/db/queries/groups.js'
import { maybeEnqueueQaJob, QA_FRESHNESS_MS } from '../../src/bot/trigger.js'
import { registerSentMessage } from '../../src/bot/sent-registry.js'
import { getJob } from '../../src/db/queries/jobs.js'

const BOT_JID = '15550001234@s.whatsapp.net'
const BOT_LID = '98765432101234@lid'
const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => {
  dbs = setupTestDbs()
  updateBotUser({ id: BOT_JID, lid: BOT_LID } as never)
  seedGroup('qa@g.us', 'Admins')
  seedGroup('other@g.us', 'Other')
  updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['other@g.us'] })
})
afterEach(() => { dbs.cleanup() })

function record(over: Partial<{
  groupJid: string; userJid: string; messageId: string; parentId: string | null
  eventType: string; metadata: Record<string, unknown> | null; timestamp: number
}> = {}) {
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

describe('maybeEnqueueQaJob', () => {
  it('enqueues on @mention of the bot phone jid', () => {
    const id = maybeEnqueueQaJob(record(), NOW_MS)
    expect(id).not.toBeNull()
    const job = getJob(id!)!
    expect(job.jobType).toBe('qa_answer')
    expect(job.payload).toEqual({ text: 'how many messages?' })
    expect(job.expiresAt).toBe(Math.floor(NOW_S - 5 + QA_FRESHNESS_MS / 1000))
  })

  it('enqueues on @mention of the bot LID (Review Focus 1)', () => {
    const id = maybeEnqueueQaJob(record({ metadata: { text: 'hi', mentions: [BOT_LID] } }), NOW_MS)
    expect(id).not.toBeNull()
  })

  it('ignores mentions of other members (Review Focus 1)', () => {
    const id = maybeEnqueueQaJob(record({ metadata: { text: 'hi', mentions: ['somebody@s.whatsapp.net'] } }), NOW_MS)
    expect(id).toBeNull()
  })

  it('enqueues on a reply to a bot message with quotedBotMessageId in payload', () => {
    seedMessage('qa@g.us', BOT_LID, 'earlier answer', NOW_S - 60, { messageId: 'BOTMSG' })
    const id = maybeEnqueueQaJob(record({ parentId: 'BOTMSG', metadata: { text: 'and for August?' } }), NOW_MS)
    expect(id).not.toBeNull()
    expect(getJob(id!)!.payload).toEqual({ text: 'and for August?', quotedBotMessageId: 'BOTMSG' })
  })

  it('ignores replies to non-bot messages', () => {
    seedMessage('qa@g.us', 'human@s.whatsapp.net', 'some msg', NOW_S - 60, { messageId: 'HUMANMSG' })
    expect(maybeEnqueueQaJob(record({ parentId: 'HUMANMSG', metadata: { text: 'ok' } }), NOW_MS)).toBeNull()
  })

  it('ignores groups without the QA bit', () => {
    expect(maybeEnqueueQaJob(record({ groupJid: 'other@g.us' }), NOW_MS)).toBeNull()
  })

  it('ignores messages the responder itself sent', () => {
    const rec = record()
    registerSentMessage((rec as { messageId: string }).messageId)
    expect(maybeEnqueueQaJob(rec, NOW_MS)).toBeNull()
  })

  it('ignores stale messages (freshness window)', () => {
    expect(maybeEnqueueQaJob(record({ timestamp: NOW_S - 601 }), NOW_MS)).toBeNull()
    expect(maybeEnqueueQaJob(record({ timestamp: NOW_S - 599 }), NOW_MS)).not.toBeNull()
  })

  it('ignores non-message events and empty text', () => {
    expect(maybeEnqueueQaJob(record({ eventType: 'reaction' }), NOW_MS)).toBeNull()
    expect(maybeEnqueueQaJob(record({ metadata: { mentions: [BOT_JID] } }), NOW_MS)).toBeNull()
    expect(maybeEnqueueQaJob(record({ metadata: { text: '   ', mentions: [BOT_JID] } }), NOW_MS)).toBeNull()
  })

  it('never enqueues the same message twice', () => {
    const rec = record({ messageId: 'SAME' })
    expect(maybeEnqueueQaJob(rec, NOW_MS)).not.toBeNull()
    expect(maybeEnqueueQaJob(rec, NOW_MS)).toBeNull()
  })
})
