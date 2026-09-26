import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMessage } from '../helpers/fixtures.js'
import { insertJob, getJob } from '../../src/db/queries/jobs.js'
import { getCreationRecord } from '../../src/db/queries/activity.js'
import { wasSentByBot } from '../../src/bot/sent-registry.js'

const BOT_JID = '15550001234@s.whatsapp.net'
const BOT_LID = '99887766001@lid'
const NOW_S = Math.floor(Date.now() / 1000)

const fake = vi.hoisted(() => ({
  calls: [] as { kind: string; args: unknown[]; preRegistered: boolean }[],
  sock: null as unknown as Record<string, unknown>,
}))

vi.mock('../../src/whatsapp/client.js', async () => {
  const { wasSentByBot } = await import('../../src/bot/sent-registry.js')
  fake.sock = {
    user: { id: '15550001234:7@s.whatsapp.net', lid: '99887766001:2@lid' },
    async sendMessage(...args: unknown[]) {
      const opts = args[2] as { messageId: string }
      fake.calls.push({ kind: 'sendMessage', args, preRegistered: wasSentByBot(opts.messageId) })
      return { key: { id: opts.messageId } }
    },
    async relayMessage(...args: unknown[]) {
      const opts = args[2] as { messageId: string }
      fake.calls.push({ kind: 'relayMessage', args, preRegistered: wasSentByBot(opts.messageId) })
      return undefined
    },
    async sendPresenceUpdate() { /* noop */ },
  }
  return {
    getSock: () => fake.sock,
    cacheMessage: () => undefined,
    getCachedMessage: () => undefined,
    getEncryptionContext: () => null,
    startConnection: async () => undefined,
  }
})

import { sendJobReply } from '../../src/bot/setup.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'

let dbs: ReturnType<typeof setupTestDbs>

beforeEach(() => {
  dbs = setupTestDbs()
  fake.calls = []
  updateBotUser({ id: BOT_JID, lid: BOT_LID } as never)
  seedGroup('qa@g.us', 'Admins')
  seedGroup('120363000000000001@g.us', 'Alpha')
  seedUser('88112233445@lid', 'Zoe')
})
afterEach(() => { dbs.cleanup() })

function makeJob() {
  const qId = seedMessage('qa@g.us', 'asker@lid', 'question?', NOW_S - 5, {
    raw: { key: { remoteJid: 'qa@g.us', id: 'Q1', participant: 'asker@lid' }, message: { conversation: 'question?' } },
  })
  const id = insertJob({
    jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: qId,
    payload: { text: 'question?' }, runAt: NOW_S, expiresAt: NOW_S + 600,
  })!
  return getJob(id)!
}

describe('sendJobReply', () => {
  it('sends plain replies through sendMessage, quoted, id pre-registered before the send', async () => {
    const sentId = await sendJobReply(makeJob(), 'Answer for @88112233445.')
    expect(sentId).toBeTruthy()
    expect(fake.calls.length).toBe(1)
    const call = fake.calls[0]
    expect(call.kind).toBe('sendMessage')
    expect(call.preRegistered).toBe(true) // registered BEFORE the send (echo race)
    const [jid, content, opts] = call.args as [string, Record<string, unknown>, Record<string, unknown>]
    expect(jid).toBe('qa@g.us')
    expect(content.mentions).toEqual(['88112233445@lid'])
    expect((opts.quoted as { key: { id: string } }).key.id).toBe('Q1')
    expect(wasSentByBot(opts.messageId as string)).toBe(true)
  })

  it('wraps group mentions in a groupMentionedMessage envelope with full-jid tokens via relayMessage', async () => {
    const sentId = await sendJobReply(makeJob(), 'Most active: @120363000000000001 (see @88112233445).')
    expect(sentId).toBeTruthy()
    const call = fake.calls[0]
    expect(call.kind).toBe('relayMessage')
    expect(call.preRegistered).toBe(true)
    const [jid, message] = call.args as [string, Record<string, any>]
    expect(jid).toBe('qa@g.us')
    const inner = message.groupMentionedMessage.message.extendedTextMessage
    expect(inner.text).toBe('Most active: @120363000000000001@g.us (see @88112233445).')
    expect(inner.contextInfo.groupMentions).toEqual([{ groupJid: '120363000000000001@g.us', groupSubject: 'Alpha' }])
    expect(inner.contextInfo.mentionedJid).toEqual(['88112233445@lid'])
    expect(inner.contextInfo.stanzaId).toBe('Q1') // still quoted to the question
  })

  it('records its own activity row on the relay path (no self-echo there)', async () => {
    const job = makeJob()
    const sentId = await sendJobReply(job, 'Stats for @120363000000000001 follow.')
    const row = getCreationRecord('qa@g.us', sentId!)
    expect(row).toBeTruthy()
    expect((row!.metadata as { text?: string }).text).toBe('Stats for @120363000000000001@g.us follow.')
  })
})
