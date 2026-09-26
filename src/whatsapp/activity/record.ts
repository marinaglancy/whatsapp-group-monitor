import { getContentType, proto, jidNormalizedUser, decryptPollVote, decryptEventResponse, getKeyAuthor } from 'baileys'
import { createHash } from 'crypto'
import type { WAMessage } from 'baileys'
import type { ActivityEventType, GroupActivityRow } from '../../db/schema.js'
import { insertActivity } from '../../db/queries/activity.js'
import { processRecord } from './processor.js'
import { getSock, getEncryptionContext } from '../client.js'
import { logger } from '../../utils/logger.js'

/** Convert a value to a JSON-safe object (replace binary, bigint) */
function safeJson(obj: unknown): unknown {
  return JSON.parse(JSON.stringify(obj, (_key, value) => {
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) return '[binary]'
    if (typeof value === 'bigint') return value.toString()
    return value
  }))
}

function extractText(message: proto.IMessage): string | null {
  if (message.conversation) return message.conversation
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text
  if (message.imageMessage?.caption) return message.imageMessage.caption
  if (message.videoMessage?.caption) return message.videoMessage.caption
  if (message.documentMessage?.caption) return message.documentMessage.caption
  return null
}

function extractMentions(message: proto.IMessage): string[] {
  const content = message.extendedTextMessage
    || message.imageMessage
    || message.videoMessage
    || message.audioMessage
    || message.documentMessage
    || message.stickerMessage
  const mentioned = (content as { contextInfo?: { mentionedJid?: string[] } } | undefined)?.contextInfo?.mentionedJid || []
  return mentioned.map(j => jidNormalizedUser(j))
}

function extractQuotedId(message: proto.IMessage): string | null {
  const content = message.extendedTextMessage
    || message.imageMessage
    || message.videoMessage
    || message.audioMessage
    || message.documentMessage
    || message.stickerMessage
  return (content as { contextInfo?: { stanzaId?: string } } | undefined)?.contextInfo?.stanzaId || null
}

export class ActivityRecord {
  groupJid: string
  userJid: string
  messageId: string
  parentId: string | null
  eventType: ActivityEventType
  metadata: Record<string, unknown> | null
  raw: Record<string, unknown> | null
  timestamp: number
  id?: number // set when loaded from DB

  private constructor(data: {
    groupJid: string
    userJid: string
    messageId: string
    parentId?: string | null
    eventType: ActivityEventType
    metadata?: Record<string, unknown> | null
    raw?: Record<string, unknown> | null
    timestamp: number
    id?: number
  }) {
    this.groupJid = data.groupJid
    this.userJid = data.userJid
    this.messageId = data.messageId
    this.parentId = data.parentId ?? null
    this.eventType = data.eventType
    this.metadata = data.metadata ?? null
    this.raw = data.raw ?? null
    this.timestamp = data.timestamp
    this.id = data.id
  }

  /** Insert into group_activity_log. Returns false if duplicate. */
  save(): boolean {
    return insertActivity(this)
  }

  /** Run processing actions on this record. */
  process(): void {
    processRecord(this)
  }

  /** Save and process. */
  saveAndProcess(): void {
    const inserted = this.save()
    if (inserted) {
      this.process()
    }
  }

  /** Reconstruct from a DB row. */
  static fromDbRow(row: GroupActivityRow): ActivityRecord {
    return new ActivityRecord({
      id: row.id,
      groupJid: row.groupJid,
      userJid: row.userJid,
      messageId: row.messageId,
      parentId: row.parentId,
      eventType: row.eventType,
      metadata: row.metadata,
      raw: row.raw,
      timestamp: row.timestamp,
    })
  }

  /** Classify a WAMessage into ActivityRecord(s). Returns null if not loggable. */
  static fromMessage(msg: WAMessage, groupJid: string): ActivityRecord | null {
    const messageId = msg.key.id
    if (!messageId) return null

    let userJid: string | null = null
    const participant = msg.key.participant || (msg.key as any).participantAlt
    if (participant) {
      userJid = jidNormalizedUser(participant)
    } else if (msg.key.fromMe) {
      try {
        const sock = getSock()
        userJid = jidNormalizedUser(sock.user?.lid || sock.user?.id || '')
      } catch {
        userJid = 'self'
      }
    }
    if (!userJid) return null

    const timestamp = typeof msg.messageTimestamp === 'number'
      ? msg.messageTimestamp
      : Number(msg.messageTimestamp || 0)

    const raw = safeJson({
      key: msg.key,
      message: msg.message,
      pushName: msg.pushName,
      messageStubType: msg.messageStubType,
    }) as Record<string, unknown>

    // Protocol messages: edits and deletes
    const protoMsg = msg.message?.protocolMessage
    if (protoMsg) {
      const protoType = protoMsg.type
      if (protoType === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && protoMsg.key?.id) {
        const editedMessage = protoMsg.editedMessage
        const editedText = editedMessage ? extractText(editedMessage) : null
        return new ActivityRecord({
          groupJid, userJid, messageId, timestamp, raw,
          parentId: protoMsg.key.id,
          eventType: 'edit',
          metadata: { contentType: editedMessage ? getContentType(editedMessage) : 'unknown', ...(editedText ? { text: editedText } : {}) },
        })
      }
      if (protoType === proto.Message.ProtocolMessage.Type.REVOKE && protoMsg.key?.id) {
        return new ActivityRecord({
          groupJid, userJid, messageId, timestamp, raw,
          parentId: protoMsg.key.id,
          eventType: 'delete',
        })
      }
      return null // skip other protocol messages
    }

    // Poll creation
    const pollMsg = msg.message?.pollCreationMessage
      || msg.message?.pollCreationMessageV2
      || msg.message?.pollCreationMessageV3
    if (pollMsg) {
      const secret = msg.message?.messageContextInfo?.messageSecret
      return new ActivityRecord({
        groupJid, userJid, messageId, timestamp, raw,
        eventType: 'poll_create',
        metadata: {
          question: pollMsg.name || '',
          options: (pollMsg.options || []).map(o => o.optionName || ''),
          ...(secret ? { encKey: Buffer.from(secret).toString('base64') } : {}),
        },
      })
    }

    // Poll vote
    const pollUpdate = msg.message?.pollUpdateMessage
    if (pollUpdate) {
      const pollMsgId = pollUpdate.pollCreationMessageKey?.id
      let decrypted = false
      let selectedOptions: string[] = []

      if (pollMsgId && pollUpdate.vote) {
        try {
          const ctx = getEncryptionContext(groupJid, pollMsgId)
          if (ctx && pollUpdate.pollCreationMessageKey) {
            const sock = getSock()
            const meId = jidNormalizedUser(sock.user?.id || '')
            const meLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : meId
            const isLid = msg.key.addressingMode === 'lid'

            const pollCreatorJid = isLid
              ? (pollUpdate.pollCreationMessageKey.fromMe ? meLid : (pollUpdate.pollCreationMessageKey.participant || getKeyAuthor(pollUpdate.pollCreationMessageKey, meId)))
              : getKeyAuthor(pollUpdate.pollCreationMessageKey, meId)
            const voterJid = isLid
              ? (msg.key.fromMe ? meLid : (msg.key.participant || getKeyAuthor(msg.key, meId)))
              : getKeyAuthor(msg.key, meId)

            const result = decryptPollVote(pollUpdate.vote, {
              pollEncKey: ctx.encKey,
              pollCreatorJid,
              pollMsgId,
              voterJid,
            })

            const optionHashes = new Map<string, string>()
            for (const optName of ctx.options || []) {
              const hash = createHash('sha256').update(optName).digest('hex')
              optionHashes.set(hash, optName)
            }
            selectedOptions = (result.selectedOptions || []).map(hash => {
              const hex = Buffer.from(hash).toString('hex')
              return optionHashes.get(hex) || hex
            })
            decrypted = true
          }
        } catch (err) {
          logger.warn({ err, groupJid, messageId, pollMsgId }, 'Poll vote decryption failed')
        }
      }

      if (!decrypted) {
        logger.warn({ groupJid, messageId, pollMsgId, hasContext: !!(pollMsgId && getEncryptionContext(groupJid, pollMsgId)) }, 'Poll vote stored encrypted')
      }

      return new ActivityRecord({
        groupJid, userJid, messageId, timestamp, raw,
        parentId: pollMsgId || null,
        eventType: 'poll_vote',
        metadata: decrypted ? { selectedOptions } : { encrypted: true },
      })
    }

    // Event creation
    const eventMsg = msg.message?.eventMessage
    if (eventMsg) {
      const secret = msg.message?.messageContextInfo?.messageSecret
      return new ActivityRecord({
        groupJid, userJid, messageId, timestamp, raw,
        eventType: 'event_create',
        metadata: {
          name: eventMsg.name || '',
          description: eventMsg.description || null,
          startTime: Number(eventMsg.startTime || 0) || null,
          isCanceled: eventMsg.isCanceled || false,
          ...(secret ? { encKey: Buffer.from(secret).toString('base64') } : {}),
        },
      })
    }

    // Encrypted event edit
    const secretMsg = msg.message?.secretEncryptedMessage
    if (secretMsg) {
      return new ActivityRecord({
        groupJid, userJid, messageId, timestamp, raw,
        parentId: secretMsg.targetMessageKey?.id || null,
        eventType: 'edit',
        metadata: { contentType: 'event_edit', encrypted: true },
      })
    }

    // Encrypted event response
    const encEventResp = msg.message?.encEventResponseMessage
    if (encEventResp) {
      const eventMsgId = encEventResp.eventCreationMessageKey?.id
      let responseStr: string | null = null

      if (eventMsgId && encEventResp.encPayload && encEventResp.encIv) {
        try {
          const ctx = getEncryptionContext(groupJid, eventMsgId)
          if (ctx && encEventResp.eventCreationMessageKey) {
            const eventEncKey = ctx.encKey
            const sock = getSock()
            const meId = jidNormalizedUser(sock.user?.id || '')
            const meLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : meId
            const isLid = msg.key.addressingMode === 'lid'

            const creatorKey = encEventResp.eventCreationMessageKey.participant || encEventResp.eventCreationMessageKey.remoteJid || ''
            const eventCreatorJid = isLid
              ? (encEventResp.eventCreationMessageKey.fromMe ? meLid : creatorKey)
              : getKeyAuthor(encEventResp.eventCreationMessageKey, meId)
            const responderJid = isLid
              ? (msg.key.fromMe ? meLid : (msg.key.participant || getKeyAuthor(msg.key, meId)))
              : getKeyAuthor(msg.key, meId)

            const decoded = decryptEventResponse(encEventResp, {
              eventEncKey,
              eventCreatorJid,
              eventMsgId,
              responderJid,
            })
            const r = decoded.response
            responseStr = r === 1 ? 'GOING' : r === 2 ? 'NOT_GOING' : r === 3 ? 'MAYBE' : String(r ?? 'UNKNOWN')
          }
        } catch (err) {
          logger.warn({ err, groupJid, messageId, eventMsgId }, 'Event response decryption failed')
        }
      }

      if (!responseStr) {
        logger.warn({
          groupJid,
          messageId,
          eventMsgId,
          hasContext: !!(eventMsgId && getEncryptionContext(groupJid, eventMsgId)),
          addressingMode: msg.key.addressingMode,
        }, 'Event response stored encrypted')
      }

      return new ActivityRecord({
        groupJid, userJid, messageId, timestamp, raw,
        parentId: eventMsgId || null,
        eventType: 'event_response',
        metadata: responseStr ? { response: responseStr } : { encrypted: true },
      })
    }

    // Reaction (as message — also handled via messages.reaction event)
    if (msg.message?.reactionMessage) return null

    // Pin message
    const pinMsg = msg.message?.pinInChatMessage
    if (pinMsg) {
      return new ActivityRecord({
        groupJid, userJid, messageId, timestamp, raw,
        parentId: pinMsg.key?.id || null,
        eventType: 'message',
        metadata: { contentType: 'pinInChatMessage', pinType: pinMsg.type },
      })
    }

    // Regular messages
    const contentType = msg.message ? getContentType(msg.message) : null
    if (contentType) {
      const text = extractText(msg.message!)
      const quotedId = extractQuotedId(msg.message!)
      const mentions = extractMentions(msg.message!)
      return new ActivityRecord({
        groupJid, userJid, messageId, timestamp, raw,
        parentId: quotedId,
        eventType: 'message',
        metadata: {
          contentType,
          ...(text ? { text } : {}),
          ...(quotedId ? { isReply: true } : {}),
          ...(mentions.length ? { mentions } : {}),
        },
      })
    }

    return null
  }

  /** Create a reaction ActivityRecord from a messages.reaction event entry. */
  static fromReaction(key: WAMessage['key'], reaction: { text?: string | null; groupingKey?: string | null }, userJid: string): ActivityRecord | null {
    const groupJid = key.remoteJid
    const targetMsgId = key.id
    if (!groupJid || !targetMsgId) return null

    // Reaction message ID: include timestamp to allow add+remove as separate records
    const ts = Math.floor(Date.now() / 1000)
    const messageId = reaction.groupingKey || `reaction_${targetMsgId}_${userJid}_${ts}`

    return new ActivityRecord({
      groupJid,
      userJid,
      messageId,
      parentId: targetMsgId,
      eventType: 'reaction',
      metadata: { emoji: reaction.text || null },
      timestamp: Math.floor(Date.now() / 1000),
    })
  }
}
