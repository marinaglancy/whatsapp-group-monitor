import { getContentType, proto, type WAMessage } from 'baileys'

/** How long the sender gets to re-send a message we could not decrypt. */
export const LOST_AFTER_MS = 15 * 60_000
const MAX_TRACKED = 1000

export interface LostMessage {
  messageId: string
  groupJid: string
  participant: string | null
  participantAlt: string | null
  /** Baileys' decryption error, e.g. "No session found to decrypt message". */
  reason: string | null
  firstSeenMs: number
}

const pending = new Map<string, LostMessage>()

/** Baileys could not decrypt it: a stub arrives instead of the message. The
 *  stub may still carry the sender key that did decrypt, but no content. */
function isUndecryptable(msg: WAMessage): boolean {
  return msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT
    && !getContentType(msg.message ?? undefined)
}

/** Remember an undecryptable group message, or forget it once its readable
 *  copy arrives: Baileys asks the sender to re-send, and the copy carries the
 *  same message id. Nothing records the stub itself, so without this a message
 *  that never comes back leaves no trace. */
export function trackDecryption(msg: WAMessage, groupJid: string, nowMs: number): void {
  const id = msg.key.id
  if (!id) return
  if (!isUndecryptable(msg)) {
    pending.delete(id)
    return
  }
  if (pending.has(id)) return // the stub repeats on each failed retry; keep the first sighting
  if (pending.size >= MAX_TRACKED) pending.delete(pending.keys().next().value!)
  const key = msg.key as WAMessage['key'] & { participantAlt?: string }
  pending.set(id, {
    messageId: id,
    groupJid,
    participant: key.participant ?? null,
    participantAlt: key.participantAlt ?? null,
    reason: msg.messageStubParameters?.[0] ?? null,
    firstSeenMs: nowMs,
  })
}

/** Messages still unreadable LOST_AFTER_MS after we first saw them. Each is returned once. */
export function takeLostMessages(nowMs: number): LostMessage[] {
  const lost: LostMessage[] = []
  for (const [id, entry] of pending) {
    if (nowMs - entry.firstSeenMs < LOST_AFTER_MS) continue
    lost.push(entry)
    pending.delete(id)
  }
  return lost
}

export function resetUndecryptableForTests(): void {
  pending.clear()
}
