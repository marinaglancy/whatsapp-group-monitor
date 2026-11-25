import { registerJobHandler, type JobHandler } from './worker.js'
import type { QaScope } from './scope.js'
import {
  createQaAnswerHandler, isTransientAiError, loadQaTrigger, type QaResponderDeps,
} from './responder.js'
import { addJobEvent, hasJobEvent } from '../db/queries/jobs.js'
import { getSock } from '../whatsapp/client.js'
import { postGroupMessage } from '../whatsapp/actions.js'
import { getCreationRecord } from '../db/queries/activity.js'
import { getAiSettings } from '../ai/settings.js'
import { executeQaTool, toolExecutorNames } from '../ai/tools/executors.js'
import { createGeminiProvider } from '../ai/gemini.js'
import type { BotJob } from '../db/schema.js'
import { logger } from '../utils/logger.js'
import { registerBuiltinTriggerTypes } from '../triggers/index.js'
import { buildTriggerErrorNotifier } from '../triggers/error-notifier.js'
import { TriggerGoneError, TriggerJobError } from '../triggers/errors.js'

const TOOL_ECHO_CROP = 3_000
const TOOL_ECHO_LOG_MAX = 2_000

/** Send a reply into the job's group, quoted to the originating message when
 *  its raw payload is available in the activity log. */
export async function sendJobReply(job: BotJob, text: string): Promise<string | null> {
  let quoted: { key: Record<string, unknown>; message: Record<string, unknown> } | undefined
  if (job.groupJid && job.messageId) {
    const row = getCreationRecord(job.groupJid, job.messageId)
    const raw = row?.raw as { key?: Record<string, unknown>; message?: Record<string, unknown> } | null
    if (raw?.key && raw?.message) quoted = { key: raw.key, message: raw.message }
  }
  return postGroupMessage(job.groupJid!, text, { quoted })
}

/** Best-effort "typing…" presence while a question is being answered. */
export async function setComposing(groupJid: string): Promise<void> {
  try {
    await getSock().sendPresenceUpdate('composing', groupJid)
  } catch (err) {
    logger.debug({ err, groupJid }, 'Presence update failed')
  }
}

/** Debug commands that bypass the AI entirely: "!tools" lists the tool
 *  catalog, "!tool <name> <json>" executes one against the tenant's groups and
 *  echoes the result. Free to run — no provider call, no tokens. */
async function runToolEcho(
  job: BotJob, cleaned: string, sendReply: QaResponderDeps['sendReply'], scope: QaScope,
): Promise<Record<string, unknown>> {
  if (hasJobEvent(job.id, 'reply_sent')) {
    return { note: 'reply already sent by a previous attempt' }
  }

  let text: string
  let extra: Record<string, unknown> = {}

  if (cleaned === '!tools') {
    text = '🛠 Available tools:\n' + toolExecutorNames().map(n => `- ${n}`).join('\n')
      + '\nUse: !tool <name> <json-args>'
    extra = { stub: true, tool: '!tools' }
  } else {
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
          scope,
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
  }

  const sentId = await sendReply(job, text)
  addJobEvent(job.id, 'reply_sent', {
    groupJid: job.groupJid, userJid: job.userJid, messageId: sentId,
    data: { chars: text.length, stub: true },
  })
  logger.info({ jobId: job.id, groupJid: job.groupJid }, 'Tool-echo reply sent')
  return { replyMessageId: sentId, ...extra }
}

/** The qa_answer handler: !tool debug commands go to the echo branch, real
 *  questions go to the AI responder. */
function createQaJobHandler(deps: QaResponderDeps): JobHandler {
  const respond = createQaAnswerHandler(deps)
  return async function handleQaAnswer(job: BotJob) {
    const question = typeof job.payload?.text === 'string' ? job.payload.text : ''
    // strip leading mention tokens so "@bot !tool ..." works
    const cleaned = question.replace(/^(@\d+\s*)+/, '').trim()
    if (cleaned === '!tools' || cleaned === '!tool' || cleaned.startsWith('!tool ')) {
      const { scope } = loadQaTrigger(job)
      return runToolEcho(job, cleaned, deps.sendReply, scope)
    }
    return respond(job)
  }
}

/** Register all bot job handlers. `overrides` exists for tests. */
export function setupBot(overrides: Partial<QaResponderDeps> = {}): void {
  registerBuiltinTriggerTypes()
  const deps: QaResponderDeps = {
    createProvider: createGeminiProvider,
    sendReply: sendJobReply,
    setComposing,
    ...overrides,
  }
  registerJobHandler('qa_answer', createQaJobHandler(deps), {
    // errors are a reply to the question, every time
    onFailure: buildTriggerErrorNotifier({
      send: async (job, _t, text) => ({ groupJid: job.groupJid!, messageId: await deps.sendReply(job, text) }),
      throttleMs: 0,
    }),
    // a TriggerJobError has a known cause (it may quote the AI's own words,
    // which can sound transient); a gone trigger stays gone
    shouldRetry: err => !(err instanceof TriggerJobError) && !(err instanceof TriggerGoneError) && isTransientAiError(err),
  })
}
