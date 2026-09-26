import { getGroup } from '../db/queries/groups.js'
import { getCreationRecord } from '../db/queries/activity.js'
import { insertJob } from '../db/queries/jobs.js'
import { getBotJids } from '../whatsapp/handlers/connection.js'
import { wasSentByBot } from './sent-registry.js'
import { signalWorker } from './worker.js'
import type { ProcessableRecord } from '../whatsapp/activity/processor.js'
import { logger } from '../utils/logger.js'

export const QA_FRESHNESS_MS = 600_000

/** Decide whether an activity record is a question addressed to the bot in a
 *  Q&A group; if so, insert a qa_answer job. Returns the job id or null. */
export function maybeEnqueueQaJob(record: ProcessableRecord, nowMs: number = Date.now()): number | null {
  if (record.eventType !== 'message') return null
  const text = typeof record.metadata?.text === 'string' ? record.metadata.text.trim() : ''
  if (!text) return null
  if (wasSentByBot(record.messageId)) return null

  const group = getGroup(record.groupJid)
  if (!group?.qaEnabled) return null

  const botJids = getBotJids()
  if (botJids.length === 0) return null

  const mentions = Array.isArray(record.metadata?.mentions) ? record.metadata.mentions as string[] : []
  let quotedBotMessageId: string | null = null
  if (!mentions.some(j => botJids.includes(j))) {
    if (!record.parentId) return null
    const parent = getCreationRecord(record.groupJid, record.parentId)
    if (!parent || !botJids.includes(parent.userJid)) return null
    quotedBotMessageId = record.parentId
  }

  if (nowMs - record.timestamp * 1000 > QA_FRESHNESS_MS) return null

  const id = insertJob({
    jobType: 'qa_answer',
    groupJid: record.groupJid,
    userJid: record.userJid,
    messageId: record.messageId,
    payload: { text, ...(quotedBotMessageId ? { quotedBotMessageId } : {}) },
    runAt: Math.floor(nowMs / 1000),
    expiresAt: Math.floor(record.timestamp + QA_FRESHNESS_MS / 1000),
  })
  if (id !== null) {
    logger.info({ jobId: id, groupJid: record.groupJid, messageId: record.messageId }, 'Q&A job enqueued')
    signalWorker()
  }
  return id
}
