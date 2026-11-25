import { generateMessageID, generateWAMessageFromContent, proto } from 'baileys'
import { ActivityRecord } from './activity/record.js'
import { getSock } from './client.js'
import { registerSentMessage } from '../bot/sent-registry.js'
import { getAllGroups } from '../db/queries/groups.js'
import { qFindUserJid } from '../db/queries/group-tools.js'

/** Whether an edited message keeps its group mentions tappable. Not yet
 *  checked live; set it to false if they do not survive an edit, and callers
 *  post a new message instead of editing. */
export const EDIT_KEEPS_GROUP_MENTIONS = true

type GroupMention = { groupJid: string; groupSubject: string }

/** Scan reply text for @<digits> tokens (the prompt tells the model to write
 *  groups as @<jid digits> and members as @<lid/phone digits>) and resolve
 *  them to the metadata that makes WhatsApp render tappable links. Unmatched
 *  tokens stay plain text. */
export function resolveMentionTokens(text: string): {
  mentions: string[]
  groupMentions: GroupMention[]
} {
  const tokens = [...new Set([...text.matchAll(/@(\d{5,20})/g)].map(m => m[1]))]
  const mentions: string[] = []
  const groupMentions: GroupMention[] = []
  if (!tokens.length) return { mentions, groupMentions }
  const groups = getAllGroups()
  const seenUsers = new Set<string>()
  for (const token of tokens) {
    const g = groups.find(g => g.jid.split('@')[0] === token)
    if (g) {
      groupMentions.push({ groupJid: g.jid, groupSubject: g.name })
      continue
    }
    const jid = qFindUserJid(token) // accepts lid digits or phone digits
    if (jid && !seenUsers.has(jid)) {
      seenUsers.add(jid)
      mentions.push(jid)
    }
  }
  return { mentions, groupMentions }
}

/** Rewrite matched group tokens from the prompt's @<digits> form to the
 *  @<full jid> form real WhatsApp clients put in group-mention message text —
 *  receiving phones match the token against the jid literally. */
export function expandGroupMentionTokens(text: string, groupMentions: GroupMention[]): string {
  let out = text
  for (const gm of groupMentions) {
    const digits = gm.groupJid.split('@')[0]
    out = out.replace(new RegExp(`@${digits}(?!\\d|@g\\.us)`, 'g'), `@${gm.groupJid}`)
  }
  return out
}

/** The text content of a message with group mentions. Group mentions render
 *  as tappable links only when the message is wrapped in a
 *  groupMentionedMessage envelope (see groupMentionEnvelope) and the text
 *  carries the FULL group jid (verified against a message sent by a real
 *  phone). */
function groupMentionContent(text: string, mentions: string[], groupMentions: GroupMention[]) {
  return {
    extendedTextMessage: {
      text: expandGroupMentionTokens(text, groupMentions),
      contextInfo: {
        ...(mentions.length ? { mentionedJid: mentions } : {}),
        groupMentions,
      },
    },
  }
}

function groupMentionEnvelope(message: unknown): proto.IMessage {
  return { groupMentionedMessage: { message } } as never
}

/** relayMessage has no self-echo through messages.upsert, so a message sent
 *  that way records its own activity row. */
function recordOwnMessage(groupJid: string, msg: { key: proto.IMessageKey; message?: proto.IMessage | null }): void {
  ActivityRecord.fromMessage(
    { ...msg, messageTimestamp: Math.floor(Date.now() / 1000) } as never,
    groupJid,
  )?.saveAndProcess()
}

/** Post a message into a group, optionally quoting another message. Attaches
 *  mention metadata for @<digits> tokens so groups and members render as
 *  tappable links. Returns the id of the sent message. */
export async function postGroupMessage(
  groupJid: string,
  text: string,
  opts: { quoted?: { key: Record<string, unknown>; message: Record<string, unknown> } } = {},
): Promise<string> {
  const sock = getSock()
  const { quoted } = opts
  const { mentions, groupMentions } = resolveMentionTokens(text)
  // Pre-generate and register the id BEFORE sending: Baileys echoes our own
  // message back through messages.upsert on process.nextTick, which can beat
  // the sendMessage promise — the trigger must already know it is ours.
  const messageId = generateMessageID()
  registerSentMessage(messageId)

  if (groupMentions.length) {
    // sendMessage cannot produce the envelope, so this path builds the
    // message itself, relays it, and records its own activity row.
    const fullMsg = generateWAMessageFromContent(groupJid, groupMentionContent(text, mentions, groupMentions) as never, {
      userJid: sock.user!.id,
      messageId,
      ...(quoted ? { quoted: quoted as never } : {}),
    })
    fullMsg.message = groupMentionEnvelope(fullMsg.message)
    await sock.relayMessage(groupJid, fullMsg.message!, { messageId })
    recordOwnMessage(groupJid, fullMsg)
    return messageId
  }

  const sent = await sock.sendMessage(
    groupJid,
    { text, ...(mentions.length ? { mentions } : {}) },
    { messageId, ...(quoted ? { quoted: quoted as never } : {}) },
  )
  return sent?.key?.id ?? messageId
}

/** Replace the text of a message the bot posted in a group (a MESSAGE_EDIT
 *  protocol message). The new text gets the same mention metadata as a fresh
 *  post; with group mentions, the edited content is wrapped in the same
 *  envelope. WhatsApp only accepts edits within 15 minutes of the post. */
export async function editGroupMessage(groupJid: string, messageId: string, text: string): Promise<void> {
  const sock = getSock()
  const key = { remoteJid: groupJid, fromMe: true, id: messageId }
  const { mentions, groupMentions } = resolveMentionTokens(text)

  if (groupMentions.length) {
    const content = groupMentionContent(text, mentions, groupMentions)
    const protocolMessage = { key, type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, timestampMs: Date.now() }
    const editId = generateMessageID()
    // edit '1' marks the stanza as an edit, as sendMessage does for { edit }
    await sock.relayMessage(
      groupJid,
      { protocolMessage: { ...protocolMessage, editedMessage: groupMentionEnvelope(content) } },
      { messageId: editId, additionalAttributes: { edit: '1' } },
    )
    // the row keeps the content without the envelope, like a post's row, so its text is readable
    recordOwnMessage(groupJid, {
      key: { remoteJid: groupJid, fromMe: true, id: editId },
      message: { protocolMessage: { ...protocolMessage, editedMessage: content } },
    })
    return
  }

  await sock.sendMessage(groupJid, { text, ...(mentions.length ? { mentions } : {}), edit: key })
}
