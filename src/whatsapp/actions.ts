import { generateMessageID, generateWAMessageFromContent, jidNormalizedUser, proto } from 'baileys'
import { ActivityRecord } from './activity/record.js'
import { getSock } from './client.js'
import { getBotJids } from './handlers/connection.js'
import { registerSentMessage } from '../bot/sent-registry.js'
import { getAllGroups, getGroup } from '../db/queries/groups.js'
import { qFindUserJid } from '../db/queries/group-tools.js'
import { getMembership, getUserGroupMemberships } from '../db/queries/members.js'
import { isMessageDeleted } from '../db/queries/activity.js'
import { logger } from '../utils/logger.js'

/** Whether an edited message keeps its group mentions tappable. Not yet
 *  checked live; set it to false if they do not survive an edit, and callers
 *  post a new message instead of editing. */
export const EDIT_KEEPS_GROUP_MENTIONS = true

type GroupMention = { groupJid: string; groupSubject: string }

/** Scan reply text for @<digits> tokens (the prompt tells the model to write
 *  groups as @<jid digits> and members as @<lid/phone digits>) and resolve
 *  them to the metadata that makes WhatsApp render tappable links. Old-style
 *  group ids have a hyphen (@<digits>-<digits>); such a token is only ever a
 *  group. Unmatched tokens stay plain text. */
export function resolveMentionTokens(text: string): {
  mentions: string[]
  groupMentions: GroupMention[]
} {
  const tokens = [...new Set([...text.matchAll(/@(\d{5,20}(?:-\d+)?)/g)].map(m => m[1]))]
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
    // its leading digits may be a member's (the group's creator): never a member
    if (token.includes('-')) continue
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
    // not the start of a longer token (more digits, or an old-style id's hyphen part)
    out = out.replace(new RegExp(`@${digits}(?!\\d|-\\d|@g\\.us)`, 'g'), `@${gm.groupJid}`)
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

/** Record the activity row of a message the bot sent. relayMessage has no
 *  self-echo through messages.upsert, so a message sent that way needs this.
 *  A delete sent through sendMessage uses it too, to be seen at once; its
 *  later echo has the same message id and is dropped as a duplicate. */
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

/** The outcome of deleting a message or removing a user. Refusals never ask
 *  WhatsApp: not_admin = the bot is not an admin there (or the group or
 *  community is unknown), is_admin = the user is an admin there,
 *  is_bot = the user is the bot itself. */
export type ActionResult =
  | { ok: true }
  | { ok: false; reason: 'not_admin' | 'is_admin' | 'is_bot' | 'failed'; detail?: string }

function isAdminLevel(membership: string | null | undefined): boolean {
  return membership === 'admin' || membership === 'superadmin'
}

/** From the stored group row (kept in sync by group events). */
function botIsAdminOf(jid: string): boolean {
  return isAdminLevel(getGroup(jid)?.botMembership)
}

function isBot(userJid: string): boolean {
  return getBotJids().includes(jidNormalizedUser(userJid))
}

function failed(err: unknown): ActionResult {
  return { ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) }
}

/** Run a remove call for one participant and read WhatsApp's status for them. */
async function removeParticipant(call: () => Promise<{ status: string }[]>): Promise<ActionResult> {
  try {
    const [result] = await call()
    // 404: not a participant, so the user is already gone
    if (result?.status === '200' || result?.status === '404') return { ok: true }
    return { ok: false, reason: 'failed', detail: result?.status ?? 'no result' }
  } catch (err) {
    return failed(err)
  }
}

/** Delete a member's message as a group admin. senderJid goes into the key as
 *  the message's participant: pass the author as stored on the message's
 *  activity row (the original key's participant). Records the `delete`
 *  activity row (user = the bot) at once, so isMessageDeleted sees it. */
export async function deleteMemberMessage(groupJid: string, messageId: string, senderJid: string): Promise<ActionResult> {
  if (isMessageDeleted(groupJid, messageId)) return { ok: true }
  if (!botIsAdminOf(groupJid)) return { ok: false, reason: 'not_admin' }
  const key = { remoteJid: groupJid, fromMe: false, id: messageId, participant: senderJid }
  // Pre-generated: the row recorded below and Baileys' echo of the delete
  // (messages.upsert, which can come first) share this id, so one is a duplicate.
  const deleteId = generateMessageID()
  try {
    await getSock().sendMessage(groupJid, { delete: key }, { messageId: deleteId })
  } catch (err) {
    return failed(err)
  }
  try {
    recordOwnMessage(groupJid, {
      key: { remoteJid: groupJid, fromMe: true, id: deleteId },
      message: { protocolMessage: { key, type: proto.Message.ProtocolMessage.Type.REVOKE } },
    })
  } catch (err) {
    // WhatsApp already deleted it; the echo may still record the row
    logger.warn({ err, groupJid, messageId }, 'Could not record the delete of a member message')
  }
  return { ok: true }
}

/** Remove a user from one group. Never the bot or an admin of the group; a
 *  user who already left (stored membership 'none') counts as done. */
export async function removeFromGroup(groupJid: string, userJid: string): Promise<ActionResult> {
  userJid = jidNormalizedUser(userJid)
  if (isBot(userJid)) return { ok: false, reason: 'is_bot' }
  const membership = getMembership(groupJid, userJid)?.membership
  if (isAdminLevel(membership)) return { ok: false, reason: 'is_admin' }
  if (membership === 'none') return { ok: true }
  if (!botIsAdminOf(groupJid)) return { ok: false, reason: 'not_admin' }
  return removeParticipant(() => getSock().groupParticipantsUpdate(groupJid, [userJid], 'remove'))
}

/** Remove a user from a community, which removes them from all its groups.
 *  Never the bot, nor an admin of the community or of any of its known
 *  groups. WhatsApp lists only admins in a community's own roster, so its
 *  row only tells whether they are an admin there: the user counts as
 *  already gone only when they have rows in the community's groups and
 *  every one is 'none'. */
export async function removeFromCommunity(communityJid: string, userJid: string): Promise<ActionResult> {
  userJid = jidNormalizedUser(userJid)
  if (isBot(userJid)) return { ok: false, reason: 'is_bot' }
  const memberships = getUserGroupMemberships(userJid)
    .filter(m => m.groupJid === communityJid || m.parentCommunityJid === communityJid)
  if (memberships.some(m => isAdminLevel(m.membership))) return { ok: false, reason: 'is_admin' }
  const inGroups = memberships.filter(m => m.parentCommunityJid === communityJid)
  if (inGroups.length && inGroups.every(m => m.membership === 'none')) return { ok: true }
  if (!botIsAdminOf(communityJid)) return { ok: false, reason: 'not_admin' }
  return removeParticipant(() => getSock().communityParticipantsUpdate(communityJid, [userJid], 'remove'))
}
