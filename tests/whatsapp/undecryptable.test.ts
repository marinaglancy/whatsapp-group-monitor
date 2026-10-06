import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { WAMessage } from 'baileys'
import { setupTestDbs } from '../helpers/db.js'
import { trackDecryption, takeLostMessages, resetUndecryptableForTests } from '../../src/whatsapp/activity/undecryptable.js'
import { handleMessagesUpsert } from '../../src/whatsapp/handlers/activity.js'
import { logger } from '../../src/utils/logger.js'

const T0 = Date.parse('2026-10-05T12:00:00Z')
const MIN = 60_000

// what Baileys emits when it cannot decrypt: a stub with no content (CIPHERTEXT = 2)
function unreadable(id: string, groupJid = 'g1@g.us'): WAMessage {
  return {
    key: { remoteJid: groupJid, id, participant: 'u1@lid', participantAlt: '351910000001@s.whatsapp.net', fromMe: false },
    messageStubType: 2,
    messageStubParameters: ['No session found to decrypt message'],
    messageTimestamp: T0 / 1000,
  } as unknown as WAMessage
}

// the re-sent copy WhatsApp delivers after Baileys asks: same id, real content
function readable(id: string, groupJid = 'g1@g.us'): WAMessage {
  return {
    key: { remoteJid: groupJid, id, participant: 'u1@lid', fromMe: false },
    message: { conversation: 'hello' },
    messageTimestamp: T0 / 1000,
  } as unknown as WAMessage
}

beforeEach(() => { resetUndecryptableForTests() })

describe('lost-message tracking', () => {
  it('reports a message still unreadable after 15 minutes, with its group, sender and reason', () => {
    trackDecryption(unreadable('M1'), 'g1@g.us', T0)
    expect(takeLostMessages(T0 + 15 * MIN)).toEqual([{
      messageId: 'M1', groupJid: 'g1@g.us', participant: 'u1@lid', participantAlt: '351910000001@s.whatsapp.net',
      reason: 'No session found to decrypt message', firstSeenMs: T0,
    }])
  })

  it('does not report it before 15 minutes have passed', () => {
    trackDecryption(unreadable('M1'), 'g1@g.us', T0)
    expect(takeLostMessages(T0 + 14 * MIN)).toEqual([])
  })

  it('does not report it once the re-sent copy arrives', () => {
    trackDecryption(unreadable('M1'), 'g1@g.us', T0)
    trackDecryption(readable('M1'), 'g1@g.us', T0 + 2 * MIN)
    expect(takeLostMessages(T0 + 60 * MIN)).toEqual([])
  })

  it('reports each lost message only once', () => {
    trackDecryption(unreadable('M1'), 'g1@g.us', T0)
    expect(takeLostMessages(T0 + 15 * MIN)).toHaveLength(1)
    expect(takeLostMessages(T0 + 30 * MIN)).toEqual([])
  })

  it('tracks a stub where only the sender key decrypted, not the content', () => {
    // Baileys keeps the decrypted senderKeyDistributionMessage on the stub
    const partial = { ...unreadable('M1'), message: { senderKeyDistributionMessage: { groupId: 'g1@g.us' } } } as unknown as WAMessage
    trackDecryption(partial, 'g1@g.us', T0)
    expect(takeLostMessages(T0 + 15 * MIN).map(l => l.messageId)).toEqual(['M1'])
  })

  it('counts from the first sighting when the unreadable stub repeats', () => {
    trackDecryption(unreadable('M1'), 'g1@g.us', T0)
    trackDecryption(unreadable('M1'), 'g1@g.us', T0 + 10 * MIN)
    expect(takeLostMessages(T0 + 15 * MIN).map(l => l.messageId)).toEqual(['M1'])
  })
})

describe('handleMessagesUpsert: lost messages', () => {
  let dbs: ReturnType<typeof setupTestDbs>
  beforeEach(() => { dbs = setupTestDbs(); vi.useFakeTimers(); vi.setSystemTime(T0) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); dbs.cleanup() })

  it('logs a warning for a group message that was never re-sent', () => {
    const warn = vi.spyOn(logger, 'warn')
    handleMessagesUpsert({ messages: [unreadable('M1')], type: 'notify' })
    vi.setSystemTime(T0 + 16 * MIN)
    handleMessagesUpsert({ messages: [readable('OTHER')], type: 'notify' })
    const lostLogs = warn.mock.calls.filter(c => /lost/i.test(String(c[1])))
    expect(lostLogs).toHaveLength(1)
    expect(lostLogs[0][0]).toMatchObject({ groupJid: 'g1@g.us', messageId: 'M1', participant: 'u1@lid' })
  })

  it('stays quiet when the message was re-sent in time', () => {
    const warn = vi.spyOn(logger, 'warn')
    handleMessagesUpsert({ messages: [unreadable('M1')], type: 'notify' })
    vi.setSystemTime(T0 + 1 * MIN)
    handleMessagesUpsert({ messages: [readable('M1')], type: 'notify' })
    vi.setSystemTime(T0 + 16 * MIN)
    handleMessagesUpsert({ messages: [readable('OTHER')], type: 'notify' })
    expect(warn.mock.calls.filter(c => /lost/i.test(String(c[1])))).toHaveLength(0)
  })
})
