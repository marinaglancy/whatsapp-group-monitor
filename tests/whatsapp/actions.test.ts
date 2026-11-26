import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { proto } from 'baileys'
import { setupTestDbs } from '../helpers/db.js'
import { and, eq } from 'drizzle-orm'
import { seedGroup, seedUser, seedMember, seedMessage } from '../helpers/fixtures.js'
import { getCreationRecord, isMessageDeleted } from '../../src/db/queries/activity.js'
import { updateBotMembership } from '../../src/db/queries/groups.js'
import { getAccountDb } from '../../src/db/account.js'
import { groupActivityLog } from '../../src/db/schema.js'
import { wasSentByBot } from '../../src/bot/sent-registry.js'

const BOT_JID = '15550001234@s.whatsapp.net'
const BOT_LID = '99887766001@lid'

const fake = vi.hoisted(() => ({
  calls: [] as { kind: string; args: unknown[]; preRegistered: boolean }[],
  sock: null as unknown as Record<string, unknown>,
  /** the status WhatsApp gives each participant of a remove */
  participantStatus: '200',
  /** an error the next socket call throws */
  failWith: null as Error | null,
  /** runs inside sendMessage, before it returns */
  onSend: null as ((args: unknown[]) => void) | null,
}))

vi.mock('../../src/whatsapp/client.js', async () => {
  const { wasSentByBot } = await import('../../src/bot/sent-registry.js')
  fake.sock = {
    user: { id: '15550001234:7@s.whatsapp.net', lid: '99887766001:2@lid' },
    async sendMessage(...args: unknown[]) {
      const opts = (args[2] ?? {}) as { messageId?: string }
      fake.calls.push({ kind: 'sendMessage', args, preRegistered: !!opts.messageId && wasSentByBot(opts.messageId) })
      if (fake.failWith) throw fake.failWith
      fake.onSend?.(args)
      return { key: { id: opts.messageId ?? 'GENERATED' } }
    },
    async groupParticipantsUpdate(...args: unknown[]) {
      fake.calls.push({ kind: 'groupParticipantsUpdate', args, preRegistered: false })
      if (fake.failWith) throw fake.failWith
      return (args[1] as string[]).map(jid => ({ status: fake.participantStatus, jid }))
    },
    async communityParticipantsUpdate(...args: unknown[]) {
      fake.calls.push({ kind: 'communityParticipantsUpdate', args, preRegistered: false })
      if (fake.failWith) throw fake.failWith
      return (args[1] as string[]).map(jid => ({ status: fake.participantStatus, jid }))
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

import {
  postGroupMessage, editGroupMessage, deleteMemberMessage, removeFromGroup, removeFromCommunity,
} from '../../src/whatsapp/actions.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { handleMessagesUpsert } from '../../src/whatsapp/handlers/activity.js'

const REPORTS = 'reports@g.us'
const ALPHA = '120363000000000001@g.us'
const ZOE = '88112233445@lid'

let dbs: ReturnType<typeof setupTestDbs>

beforeEach(() => {
  dbs = setupTestDbs()
  fake.calls = []
  fake.participantStatus = '200'
  fake.failWith = null
  fake.onSend = null
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


/** The delete rows recorded for one message. */
function deleteRows(groupJid: string, messageId: string) {
  return getAccountDb().select().from(groupActivityLog).where(and(
    eq(groupActivityLog.groupJid, groupJid),
    eq(groupActivityLog.eventType, 'delete'),
    eq(groupActivityLog.parentId, messageId),
  )).all()
}

/** The message Baileys echoes back through messages.upsert after sending a delete. */
function deleteEcho(args: unknown[]) {
  const [jid, content, opts] = args as Args
  return {
    key: { remoteJid: jid, fromMe: true, id: opts.messageId },
    message: { protocolMessage: { key: content.delete, type: proto.Message.ProtocolMessage.Type.REVOKE } },
    messageTimestamp: Math.floor(Date.now() / 1000),
  }
}

describe('deleteMemberMessage', () => {
  beforeEach(() => {
    seedMessage(ALPHA, ZOE, 'Buy now!', 1_700_000_000, { messageId: 'M1' })
  })

  it('deletes as an admin, with the original sender in the key, and records the delete row at once', async () => {
    updateBotMembership(ALPHA, 'admin')
    expect(await deleteMemberMessage(ALPHA, 'M1', ZOE)).toEqual({ ok: true })
    expect(fake.calls.length).toBe(1)
    const call = fake.calls[0]
    expect(call.kind).toBe('sendMessage')
    const [jid, content, opts] = call.args as Args
    expect(jid).toBe(ALPHA)
    expect(content).toEqual({ delete: { remoteJid: ALPHA, fromMe: false, id: 'M1', participant: ZOE } })
    expect(opts.messageId).toBeTruthy()

    expect(isMessageDeleted(ALPHA, 'M1')).toBe(true)
    const rows = deleteRows(ALPHA, 'M1')
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ messageId: opts.messageId, userJid: BOT_LID })
  })

  it('works the same when the bot is the group owner (superadmin)', async () => {
    updateBotMembership(ALPHA, 'superadmin')
    expect(await deleteMemberMessage(ALPHA, 'M1', ZOE)).toEqual({ ok: true })
    expect(isMessageDeleted(ALPHA, 'M1')).toBe(true)
  })

  it.each(['before', 'after'])('keeps one delete row when WhatsApp echoes the delete back %s sendMessage returns', async (when) => {
    updateBotMembership(ALPHA, 'admin')
    const echo = (args: unknown[]) => handleMessagesUpsert({ messages: [deleteEcho(args)], type: 'append' } as never)
    if (when === 'before') fake.onSend = echo
    expect(await deleteMemberMessage(ALPHA, 'M1', ZOE)).toEqual({ ok: true })
    if (when === 'after') echo(fake.calls[0].args)
    const rows = deleteRows(ALPHA, 'M1')
    expect(rows.length).toBe(1)
    expect(rows[0].userJid).toBe(BOT_LID)
  })

  it('treats a message already deleted (by anyone) as done, without asking WhatsApp', async () => {
    updateBotMembership(ALPHA, 'admin')
    seedMessage(ALPHA, '55500000001@lid', '', 1_700_000_005, { eventType: 'delete', parentId: 'M1', messageId: 'D0' })
    expect(await deleteMemberMessage(ALPHA, 'M1', ZOE)).toEqual({ ok: true })
    expect(fake.calls).toEqual([])
    expect(deleteRows(ALPHA, 'M1').length).toBe(1)
  })

  it('refuses without asking WhatsApp when the bot is not an admin of the group, or the group is unknown', async () => {
    expect(await deleteMemberMessage(ALPHA, 'M1', ZOE)).toEqual({ ok: false, reason: 'not_admin' })
    expect(await deleteMemberMessage('unknown@g.us', 'M1', ZOE)).toEqual({ ok: false, reason: 'not_admin' })
    expect(fake.calls).toEqual([])
    expect(isMessageDeleted(ALPHA, 'M1')).toBe(false)
  })

  it('reports a failed delete with the error, and records nothing', async () => {
    updateBotMembership(ALPHA, 'admin')
    fake.failWith = new Error('forbidden')
    expect(await deleteMemberMessage(ALPHA, 'M1', ZOE)).toEqual({ ok: false, reason: 'failed', detail: 'forbidden' })
    expect(isMessageDeleted(ALPHA, 'M1')).toBe(false)
  })
})

describe('removeFromGroup', () => {
  beforeEach(() => {
    updateBotMembership(ALPHA, 'admin')
  })

  it('removes a member through groupParticipantsUpdate', async () => {
    seedMember(ALPHA, ZOE)
    expect(await removeFromGroup(ALPHA, ZOE)).toEqual({ ok: true })
    expect(fake.calls.map(c => [c.kind, c.args])).toEqual([['groupParticipantsUpdate', [ALPHA, [ZOE], 'remove']]])
  })

  it('asks WhatsApp when there is no stored membership for the user', async () => {
    expect(await removeFromGroup(ALPHA, ZOE)).toEqual({ ok: true })
    expect(fake.calls.length).toBe(1)
  })

  it('never removes an admin or the owner of the group', async () => {
    seedMember(ALPHA, ZOE, 'admin')
    seedMember(ALPHA, '55500000002@lid', 'superadmin')
    expect(await removeFromGroup(ALPHA, ZOE)).toEqual({ ok: false, reason: 'is_admin' })
    expect(await removeFromGroup(ALPHA, '55500000002@lid')).toEqual({ ok: false, reason: 'is_admin' })
    expect(fake.calls).toEqual([])
  })

  it('never removes the bot itself, by its lid or its phone id (with or without a device)', async () => {
    expect(await removeFromGroup(ALPHA, BOT_LID)).toEqual({ ok: false, reason: 'is_bot' })
    expect(await removeFromGroup(ALPHA, BOT_JID)).toEqual({ ok: false, reason: 'is_bot' })
    expect(await removeFromGroup(ALPHA, '15550001234:7@s.whatsapp.net')).toEqual({ ok: false, reason: 'is_bot' })
    expect(fake.calls).toEqual([])
  })

  it('treats a user who already left or was removed as done, without asking WhatsApp', async () => {
    seedMember(ALPHA, ZOE, 'none')
    expect(await removeFromGroup(ALPHA, ZOE)).toEqual({ ok: true })
    expect(fake.calls).toEqual([])
  })

  it('refuses without asking WhatsApp when the bot is not an admin of the group, or the group is unknown', async () => {
    updateBotMembership(ALPHA, 'participant')
    seedMember(ALPHA, ZOE)
    expect(await removeFromGroup(ALPHA, ZOE)).toEqual({ ok: false, reason: 'not_admin' })
    expect(await removeFromGroup('unknown@g.us', ZOE)).toEqual({ ok: false, reason: 'not_admin' })
    expect(fake.calls).toEqual([])
  })

  it('counts "not a participant" (404) as done, any other status as failed', async () => {
    seedMember(ALPHA, ZOE)
    fake.participantStatus = '404'
    expect(await removeFromGroup(ALPHA, ZOE)).toEqual({ ok: true })
    fake.participantStatus = '403'
    expect(await removeFromGroup(ALPHA, ZOE)).toEqual({ ok: false, reason: 'failed', detail: '403' })
  })

  it('reports a thrown error as failed, with its message', async () => {
    seedMember(ALPHA, ZOE)
    fake.failWith = new Error('timed out')
    expect(await removeFromGroup(ALPHA, ZOE)).toEqual({ ok: false, reason: 'failed', detail: 'timed out' })
  })
})

describe('removeFromCommunity', () => {
  const COMMUNITY = '120363000000000100@g.us'
  const CHILD = '120363000000000101@g.us'
  const OTHER_CHILD = '120363000000000102@g.us'

  beforeEach(() => {
    seedGroup(COMMUNITY, 'Community', { isCommunity: true, botMembership: 'admin' })
    seedGroup(CHILD, 'Child', { parentCommunityJid: COMMUNITY })
    seedGroup(OTHER_CHILD, 'Other child', { parentCommunityJid: COMMUNITY })
  })

  it('removes a member from the whole community through communityParticipantsUpdate', async () => {
    seedMember(CHILD, ZOE)
    expect(await removeFromCommunity(COMMUNITY, ZOE)).toEqual({ ok: true })
    expect(fake.calls.map(c => [c.kind, c.args])).toEqual([['communityParticipantsUpdate', [COMMUNITY, [ZOE], 'remove']]])
  })

  it('never removes an admin of the community or of any of its groups', async () => {
    seedMember(COMMUNITY, ZOE, 'admin')
    seedMember(OTHER_CHILD, '55500000003@lid', 'superadmin')
    seedMember(CHILD, '55500000003@lid')
    expect(await removeFromCommunity(COMMUNITY, ZOE)).toEqual({ ok: false, reason: 'is_admin' })
    expect(await removeFromCommunity(COMMUNITY, '55500000003@lid')).toEqual({ ok: false, reason: 'is_admin' })
    expect(fake.calls).toEqual([])
  })

  it('never removes the bot itself', async () => {
    expect(await removeFromCommunity(COMMUNITY, BOT_LID)).toEqual({ ok: false, reason: 'is_bot' })
    expect(fake.calls).toEqual([])
  })

  it('refuses without asking WhatsApp when the bot is not a community admin, or the community is unknown', async () => {
    seedMember(CHILD, ZOE)
    expect(await removeFromCommunity('120363000000000199@g.us', ZOE)).toEqual({ ok: false, reason: 'not_admin' })
    updateBotMembership(COMMUNITY, 'participant')
    expect(await removeFromCommunity(COMMUNITY, ZOE)).toEqual({ ok: false, reason: 'not_admin' })
    expect(fake.calls).toEqual([])
  })

  it('treats a user gone from the community and all its known groups as done, without asking WhatsApp', async () => {
    seedMember(CHILD, ZOE, 'none')
    seedMember(OTHER_CHILD, ZOE, 'none')
    expect(await removeFromCommunity(COMMUNITY, ZOE)).toEqual({ ok: true })
    expect(fake.calls).toEqual([])
  })

  it('still asks WhatsApp when only the community row says gone (its roster lists only admins) but a group has them', async () => {
    seedMember(COMMUNITY, ZOE, 'none')
    seedMember(CHILD, ZOE)
    expect(await removeFromCommunity(COMMUNITY, ZOE)).toEqual({ ok: true })
    expect(fake.calls.length).toBe(1)
  })

  it('counts "not a participant" (404) as done, any other status as failed', async () => {
    seedMember(CHILD, ZOE)
    fake.participantStatus = '404'
    expect(await removeFromCommunity(COMMUNITY, ZOE)).toEqual({ ok: true })
    fake.participantStatus = '500'
    expect(await removeFromCommunity(COMMUNITY, ZOE)).toEqual({ ok: false, reason: 'failed', detail: '500' })
    fake.failWith = new Error('boom')
    expect(await removeFromCommunity(COMMUNITY, ZOE)).toEqual({ ok: false, reason: 'failed', detail: 'boom' })
  })
})
