import { registerJobHandler } from './worker.js'
import { registerSentMessage } from './sent-registry.js'
import { addJobEvent, hasJobEvent } from '../db/queries/jobs.js'
import { getSock } from '../whatsapp/client.js'
import { getCreationRecord } from '../db/queries/activity.js'
import type { BotJob } from '../db/schema.js'
import { logger } from '../utils/logger.js'

export type SendReply = (job: BotJob, text: string) => Promise<string | null>

/** Send a reply into the job's group, quoted to the originating message when
 *  its raw payload is available in the activity log. */
export async function sendJobReply(job: BotJob, text: string): Promise<string | null> {
  const sock = getSock()
  let quoted: { key: Record<string, unknown>; message: Record<string, unknown> } | undefined
  if (job.groupJid && job.messageId) {
    const row = getCreationRecord(job.groupJid, job.messageId)
    const raw = row?.raw as { key?: Record<string, unknown>; message?: Record<string, unknown> } | null
    if (raw?.key && raw?.message) quoted = { key: raw.key, message: raw.message }
  }
  const sent = await sock.sendMessage(
    job.groupJid!,
    { text },
    quoted ? { quoted: quoted as never } : undefined,
  )
  const id = sent?.key?.id ?? null
  if (id) registerSentMessage(id)
  return id
}

/** TEMPORARY phase-2 handler: acknowledges questions with a fixed reply.
 *  Replaced by the AI responder in phase 4. */
function createStubQaHandler(sendReply: SendReply) {
  return async function handleQaAnswerStub(job: BotJob): Promise<Record<string, unknown>> {
    // Idempotency: a previous attempt may have crashed after sending the reply.
    if (hasJobEvent(job.id, 'reply_sent')) {
      return { note: 'reply already sent by a previous attempt' }
    }
    const question = typeof job.payload?.text === 'string' ? job.payload.text : ''
    const text = `🤖 Job #${job.id} logged. I heard: "${question.slice(0, 120)}"\n_(AI answers arrive in a later phase.)_`
    const sentId = await sendReply(job, text)
    addJobEvent(job.id, 'reply_sent', {
      groupJid: job.groupJid, userJid: job.userJid, messageId: sentId,
      data: { chars: text.length, stub: true },
    })
    logger.info({ jobId: job.id, groupJid: job.groupJid }, 'Stub Q&A reply sent')
    return { replyMessageId: sentId, stub: true }
  }
}

/** Register all bot job handlers. `overrides` exists for tests. */
export function setupBot(overrides: { sendReply?: SendReply } = {}): void {
  registerJobHandler('qa_answer', createStubQaHandler(overrides.sendReply ?? sendJobReply))
}
