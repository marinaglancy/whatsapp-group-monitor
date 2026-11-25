import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { proto } from 'baileys'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser } from '../helpers/fixtures.js'
import { getCreationRecord } from '../../src/db/queries/activity.js'
import { wasSentByBot } from '../../src/bot/sent-registry.js'

const BOT_JID = '15550001234@s.whatsapp.net'
const BOT_LID = '99887766001@lid'

const fake = vi.hoisted(() => ({
  calls: [] as { kind: string; args: unknown[]; preRegistered: boolean }[],
  sock: null as unknown as Record<string, unknown>,
}))

vi.mock('../../src/whatsapp/client.js', async () => {
  const { wasSentByBot } = await import('../../src/bot/sent-registry.js')
  fake.sock = {
    user: { id: '15550001234:7@s.whatsapp.net', lid: '99887766001:2@lid' },
    async sendMessage(...args: unknown[]) {
      const opts = (args[2] ?? {}) as { messageId?: string }
      fake.calls.push({ kind: 'sendMessage', args, preRegistered: !!opts.messageId && wasSentByBot(opts.messageId) })
      return { key: { id: opts.messageId ?? 'GENERATED' } }
    },
    async relayMessage(...args: unknown[]) {
      const opts = args[2] as { messageId: string }
      fake.calls.push({ kind: 'relayMessage', args, preRegistered: wasSentByBot(opts.messageId) })
      return opts.messageId
    },
  }
  return {
    getSock: () => fake.sock,
    cacheMessage: () => undefined,
    getCachedMessage: () => undefined,
    getEncryptionContext: () => null,
    startConnection: async () => undefined,
  }
})

import { postGroupMessage, editGroupMessage } from '../../src/whatsapp/actions.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'

const REPORTS = 'reports@g.us'
const ALPHA = '120363000000000001@g.us'

let dbs: ReturnType<typeof setupTestDbs>

beforeEach(() => {
  dbs = setupTestDbs()
  fake.calls = []
  updateBotUser({ id: BOT_JID, lid: BOT_LID } as never)
  seedGroup(REPORTS, 'Reports')
  seedGroup(ALPHA, 'Alpha')
  seedUser('88112233445@lid', 'Zoe')
})
afterEach(() => { dbs.cleanup() })

type Args = [string, Record<string, any>, Record<string, any>]

describe('postGroupMessage', () => {
  it('sends plain text through sendMessage, not quoted, with the id registered before the send', async () => {
    const id = await postGroupMessage(REPORTS, 'All quiet.')
    expect(fake.calls.length).toBe(1)
    const call = fake.calls[0]
    expect(call.kind).toBe('sendMessage')
    expect(call.preRegistered).toBe(true)
    const [jid, content, opts] = call.args as Args
    expect(jid).toBe(REPORTS)
    expect(content).toEqual({ text: 'All quiet.' })
    expect(opts.quoted).toBeUndefined()
    expect(id).toBe(opts.messageId)
    expect(wasSentByBot(id)).toBe(true)
  })

  it('adds member mentions and passes a quoted message on', async () => {
    const quoted = { key: { remoteJid: REPORTS, id: 'Q1', participant: 'asker@lid' }, message: { conversation: 'hi' } }
    await postGroupMessage(REPORTS, 'Spam by @88112233445.', { quoted })
    const [, content, opts] = fake.calls[0].args as Args
    expect(content).toEqual({ text: 'Spam by @88112233445.', mentions: ['88112233445@lid'] })
    expect(opts.quoted).toBe(quoted)
  })

  it('wraps group mentions in a groupMentionedMessage envelope and records its own activity row', async () => {
    const id = await postGroupMessage(REPORTS, 'Spam in @120363000000000001 by @88112233445.')
    const call = fake.calls[0]
    expect(call.kind).toBe('relayMessage')
    expect(call.preRegistered).toBe(true)
    const [jid, message, opts] = call.args as Args
    expect(jid).toBe(REPORTS)
    expect(opts.messageId).toBe(id)
    const inner = message.groupMentionedMessage.message.extendedTextMessage
    expect(inner.text).toBe('Spam in @120363000000000001@g.us by @88112233445.')
    expect(inner.contextInfo.groupMentions).toEqual([{ groupJid: ALPHA, groupSubject: 'Alpha' }])
    expect(inner.contextInfo.mentionedJid).toEqual(['88112233445@lid'])
    expect(inner.contextInfo.stanzaId).toBeUndefined() // not quoted

    const row = getCreationRecord(REPORTS, id)
    expect(row).toMatchObject({ eventType: 'message', userJid: BOT_LID })
    expect((row!.metadata as { text?: string }).text).toBe('Spam in @120363000000000001@g.us by @88112233445.')
  })

  it('mentions an old-style group (id with a hyphen) as the group, not its creator', async () => {
    seedGroup('4917612345678-1500000000@g.us', 'Old group')
    seedUser('4917612345678@s.whatsapp.net', 'Its creator', '4917612345678')
    await postGroupMessage(REPORTS, 'Spam in @4917612345678-1500000000.')
    const [, message] = fake.calls[0].args as Args
    const inner = message.groupMentionedMessage.message.extendedTextMessage
    expect(inner.text).toBe('Spam in @4917612345678-1500000000@g.us.')
    expect(inner.contextInfo.groupMentions).toEqual([{ groupJid: '4917612345678-1500000000@g.us', groupSubject: 'Old group' }])
    expect(inner.contextInfo.mentionedJid).toBeUndefined()
  })
})

describe('editGroupMessage', () => {
  it('edits plain text with member mentions through sendMessage', async () => {
    await editGroupMessage(REPORTS, 'R1', 'Updated: spam by @88112233445.')
    expect(fake.calls.length).toBe(1)
    const call = fake.calls[0]
    expect(call.kind).toBe('sendMessage')
    const [jid, content] = call.args as Args
    expect(jid).toBe(REPORTS)
    expect(content).toEqual({
      text: 'Updated: spam by @88112233445.',
      mentions: ['88112233445@lid'],
      edit: { remoteJid: REPORTS, fromMe: true, id: 'R1' },
    })
  })

  it('edits with group mentions: a MESSAGE_EDIT whose edited content is the same envelope as a fresh post', async () => {
    await editGroupMessage(REPORTS, 'R1', 'Spam in @120363000000000001 by @88112233445.')
    const call = fake.calls[0]
    expect(call.kind).toBe('relayMessage')
    const [jid, message, opts] = call.args as Args
    expect(jid).toBe(REPORTS)
    const pm = message.protocolMessage
    expect(pm.type).toBe(proto.Message.ProtocolMessage.Type.MESSAGE_EDIT)
    expect(pm.key).toEqual({ remoteJid: REPORTS, fromMe: true, id: 'R1' })
    const inner = pm.editedMessage.groupMentionedMessage.message.extendedTextMessage
    expect(inner.text).toBe('Spam in @120363000000000001@g.us by @88112233445.')
    expect(inner.contextInfo).toEqual({
      mentionedJid: ['88112233445@lid'],
      groupMentions: [{ groupJid: ALPHA, groupSubject: 'Alpha' }],
    })
    // the edit is its own message, marked as an edit the way Baileys' sendMessage marks one
    expect(opts.messageId).toBeTruthy()
    expect(opts.messageId).not.toBe('R1')
    expect(opts.additionalAttributes).toEqual({ edit: '1' })

    // relayMessage has no self-echo: the edit row is recorded here
    const row = getCreationRecord(REPORTS, opts.messageId)
    expect(row).toMatchObject({ eventType: 'edit', parentId: 'R1', userJid: BOT_LID })
    expect((row!.metadata as { text?: string }).text).toBe('Spam in @120363000000000001@g.us by @88112233445.')
  })
})
