import { generateMessageID } from 'baileys'
import { registerJobHandler } from './worker.js'
import { registerSentMessage } from './sent-registry.js'
import { resolveQaScope } from './scope.js'
import { addJobEvent, hasJobEvent } from '../db/queries/jobs.js'
import { getSock } from '../whatsapp/client.js'
import { getCreationRecord } from '../db/queries/activity.js'
import { getAiSettings } from '../ai/settings.js'
import { executeQaTool, toolExecutorNames } from '../ai/tools/executors.js'
import type { BotJob } from '../db/schema.js'
import { logger } from '../utils/logger.js'

const TOOL_ECHO_CROP = 3_000
const TOOL_ECHO_LOG_MAX = 2_000

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
  // Pre-generate and register the id BEFORE sending: Baileys echoes our own
  // message back through messages.upsert on process.nextTick, which can beat
  // the sendMessage promise — the trigger must already know it is ours.
  const messageId = generateMessageID()
  registerSentMessage(messageId)
  const sent = await sock.sendMessage(
    job.groupJid!,
    { text },
    { messageId, ...(quoted ? { quoted: quoted as never } : {}) },
  )
  return sent?.key?.id ?? messageId
}

/** TEMPORARY phase-2/3 handler: acknowledges questions with a fixed reply, and
 *  supports the phase-3 tool-echo test mode (!tools, !tool <name> <json>).
 *  Replaced by the AI responder in phase 4. */
function createStubQaHandler(sendReply: SendReply) {
  return async function handleQaAnswerStub(job: BotJob): Promise<Record<string, unknown>> {
    // Idempotency: a previous attempt may have crashed after sending the reply.
    if (hasJobEvent(job.id, 'reply_sent')) {
      return { note: 'reply already sent by a previous attempt' }
    }
    const question = typeof job.payload?.text === 'string' ? job.payload.text : ''
    // strip leading mention tokens so "@bot !tool ..." works
    const cleaned = question.replace(/^(@\d+\s*)+/, '').trim()

    let text: string
    let extra: Record<string, unknown> = {}

    if (cleaned === '!tools') {
      text = '🛠 Available tools:\n' + toolExecutorNames().map(n => `- ${n}`).join('\n')
        + '\nUse: !tool <name> <json-args>'
      extra = { stub: true, tool: '!tools' }
    } else if (cleaned.startsWith('!tool')) {
      const m = /^!tool\s+(\w+)\s*([\s\S]*)$/.exec(cleaned)
      if (!m) {
        text = '⚠️ Use: !tool <name> <json-args>'
        extra = { stub: true }
      } else {
        const [, name, rawArgs] = m
        let args: Record<string, unknown> = {}
        let parseError: string | null = null
        if (rawArgs.trim()) {
          try {
            args = JSON.parse(rawArgs)
          } catch {
            parseError = '⚠️ Arguments are not valid JSON.'
          }
        }
        if (parseError) {
          text = parseError
          extra = { stub: true, tool: name }
        } else {
          const ctx = {
            scope: resolveQaScope(job.groupJid!),
            timezone: getAiSettings().timezone,
          }
          const executed = executeQaTool(name, args, ctx)
          addJobEvent(job.id, 'tool_call', {
            groupJid: job.groupJid,
            data: {
              name, args, resultChars: executed.resultChars,
              ...(executed.resultChars <= TOOL_ECHO_LOG_MAX ? { result: executed.result } : {}),
            },
          })
          let pretty = JSON.stringify(JSON.parse(executed.result), null, 2)
          if (pretty.length > TOOL_ECHO_CROP) pretty = pretty.slice(0, TOOL_ECHO_CROP) + '\n… (cropped)'
          text = pretty
          extra = { stub: true, tool: name }
        }
      }
    } else {
      text = `🤖 Job #${job.id} logged. I heard: "${question.slice(0, 120)}"\n_(AI answers arrive in a later phase.)_`
      extra = { stub: true }
    }

    const sentId = await sendReply(job, text)
    addJobEvent(job.id, 'reply_sent', {
      groupJid: job.groupJid, userJid: job.userJid, messageId: sentId,
      data: { chars: text.length, stub: true },
    })
    logger.info({ jobId: job.id, groupJid: job.groupJid }, 'Stub Q&A reply sent')
    return { replyMessageId: sentId, ...extra }
  }
}

/** Register all bot job handlers. `overrides` exists for tests. */
export function setupBot(overrides: { sendReply?: SendReply } = {}): void {
  registerJobHandler('qa_answer', createStubQaHandler(overrides.sendReply ?? sendJobReply))
}
