import { generateMessageID, generateWAMessageFromContent } from 'baileys'
import { ActivityRecord } from '../whatsapp/activity/record.js'
import { registerJobHandler, type JobHandler } from './worker.js'
import { registerSentMessage } from './sent-registry.js'
import { resolveQaScope } from './scope.js'
import { createQaAnswerHandler, buildQaFailureNotifier, type QaResponderDeps } from './responder.js'
import { addJobEvent, hasJobEvent } from '../db/queries/jobs.js'
import { getSock } from '../whatsapp/client.js'
import { getCreationRecord } from '../db/queries/activity.js'
import { getAllGroups } from '../db/queries/groups.js'
import { qFindUserJid } from '../db/queries/group-tools.js'
import { getAiSettings } from '../ai/settings.js'
import { executeQaTool, toolExecutorNames } from '../ai/tools/executors.js'
import { createGeminiProvider } from '../ai/gemini.js'
import type { BotJob } from '../db/schema.js'
import { logger } from '../utils/logger.js'

const TOOL_ECHO_CROP = 3_000
const TOOL_ECHO_LOG_MAX = 2_000

/** Scan reply text for @<digits> tokens (the prompt tells the model to write
 *  groups as @<jid digits> and members as @<lid/phone digits>) and resolve
 *  them to the metadata that makes WhatsApp render tappable links. Unmatched
 *  tokens stay plain text. */
export function resolveMentionTokens(text: string): {
  mentions: string[]
  groupMentions: { groupJid: string; groupSubject: string }[]
} {
  const tokens = [...new Set([...text.matchAll(/@(\d{5,20})/g)].map(m => m[1]))]
  const mentions: string[] = []
  const groupMentions: { groupJid: string; groupSubject: string }[] = []
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
export function expandGroupMentionTokens(text: string, groupMentions: { groupJid: string; groupSubject: string }[]): string {
  let out = text
  for (const gm of groupMentions) {
    const digits = gm.groupJid.split('@')[0]
    out = out.replace(new RegExp(`@${digits}(?!\\d|@g\\.us)`, 'g'), `@${gm.groupJid}`)
  }
  return out
}

/** Send a reply into the job's group, quoted to the originating message when
 *  its raw payload is available in the activity log. Attaches mention metadata
 *  for @<digits> tokens so groups and members render as tappable links. */
export async function sendJobReply(job: BotJob, text: string): Promise<string | null> {
  const sock = getSock()
  let quoted: { key: Record<string, unknown>; message: Record<string, unknown> } | undefined
  if (job.groupJid && job.messageId) {
    const row = getCreationRecord(job.groupJid, job.messageId)
    const raw = row?.raw as { key?: Record<string, unknown>; message?: Record<string, unknown> } | null
    if (raw?.key && raw?.message) quoted = { key: raw.key, message: raw.message }
  }
  const { mentions, groupMentions } = resolveMentionTokens(text)
  // Pre-generate and register the id BEFORE sending: Baileys echoes our own
  // message back through messages.upsert on process.nextTick, which can beat
  // the sendMessage promise — the trigger must already know it is ours.
  const messageId = generateMessageID()
  registerSentMessage(messageId)

  if (groupMentions.length) {
    // Group mentions render as tappable links only when the message is wrapped
    // in a groupMentionedMessage envelope and the text carries the FULL group
    // jid (verified against a message sent by a real phone). sendMessage cannot
    // produce the envelope, so this path builds the message itself, relays it,
    // and records its own activity row (relayMessage has no self-echo).
    const fullMsg = generateWAMessageFromContent(job.groupJid!, {
      extendedTextMessage: {
        text: expandGroupMentionTokens(text, groupMentions),
        contextInfo: {
          ...(mentions.length ? { mentionedJid: mentions } : {}),
          groupMentions,
        },
      },
    } as never, {
      userJid: sock.user!.id,
      messageId,
      ...(quoted ? { quoted: quoted as never } : {}),
    })
    fullMsg.message = { groupMentionedMessage: { message: fullMsg.message } } as never
    await sock.relayMessage(job.groupJid!, fullMsg.message!, { messageId })
    ActivityRecord.fromMessage(
      { ...fullMsg, messageTimestamp: Math.floor(Date.now() / 1000) } as never,
      job.groupJid!,
    )?.saveAndProcess()
    return messageId
  }

  const sent = await sock.sendMessage(
    job.groupJid!,
    { text, ...(mentions.length ? { mentions } : {}) },
    { messageId, ...(quoted ? { quoted: quoted as never } : {}) },
  )
  return sent?.key?.id ?? messageId
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
 *  catalog, "!tool <name> <json>" executes one against the real scope and
 *  echoes the result. Free to run — no provider call, no tokens. */
async function runToolEcho(job: BotJob, cleaned: string, sendReply: QaResponderDeps['sendReply']): Promise<Record<string, unknown>> {
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
      return runToolEcho(job, cleaned, deps.sendReply)
    }
    return respond(job)
  }
}

/** Register all bot job handlers. `overrides` exists for tests. */
export function setupBot(overrides: Partial<QaResponderDeps> = {}): void {
  const deps: QaResponderDeps = {
    createProvider: createGeminiProvider,
    sendReply: sendJobReply,
    setComposing,
    ...overrides,
  }
  registerJobHandler('qa_answer', createQaJobHandler(deps), {
    onFailure: buildQaFailureNotifier(deps),
  })
}
