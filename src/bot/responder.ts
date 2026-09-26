import type { BotJob } from '../db/schema.js'
import type { AiChatMessage, AiProvider } from '../ai/provider.js'
import { getAiSettings, expandPlaceholders, type AiSettings } from '../ai/settings.js'
import { loadToolDeclarations } from '../ai/tools/loader.js'
import { executeQaTool } from '../ai/tools/executors.js'
import { resolveQaScope, type QaScope } from './scope.js'
import { getBotUser } from '../whatsapp/handlers/connection.js'
import { getCreationRecord } from '../db/queries/activity.js'
import { getJob, addJobAiUsage, addJobEvent, getJobEvents, hasJobEvent, sumAiCallsToday } from '../db/queries/jobs.js'
import { qUsersByJids, qDataSince } from '../db/queries/group-tools.js'
import { formatDateTime } from '../utils/time.js'
import type { JobHandler } from './worker.js'
import { logger } from '../utils/logger.js'

export const QA_MAX_ROUNDS = 6
export const QA_JOB_TIMEOUT_MS = 60_000
export const QA_CONTEXT_MESSAGES = 20
export const QA_CONTEXT_MAX_AGE_MS = 48 * 3600_000
export const QA_THREAD_MAX_DEPTH = 10
export const QA_ANSWER_MAX_CHARS = 3_500
export const TOOL_RESULT_LOG_MAX = 2_000
export const LIMIT_NOTICE_INTERVAL_MS = 3_600_000

export interface QaResponderDeps {
  createProvider: (opts: { apiKey: string; model: string }) => AiProvider
  sendReply: (job: BotJob, text: string) => Promise<string | null>
  setComposing?: (groupJid: string) => Promise<void>
  nowMs?: () => number // injectable clock for tests
}

let lastLimitNoticeAt = 0

export function resetLimitNoticeForTests(): void {
  lastLimitNoticeAt = 0
}

function bareId(jid: string): string {
  return jid.split(':')[0].split('@')[0]
}

export function createQaAnswerHandler(deps: QaResponderDeps): JobHandler {
  return async function handleQaAnswer(job: BotJob): Promise<Record<string, unknown>> {
    const now = deps.nowMs ?? (() => Date.now())

    // Idempotency: a previous attempt may have crashed after sending the reply.
    if (hasJobEvent(job.id, 'reply_sent')) {
      return { note: 'reply already sent by a previous attempt' }
    }

    const question = typeof job.payload?.text === 'string' ? job.payload.text : ''
    if (!question || !job.groupJid) throw new Error('qa_answer job has no question text or group')

    const settings = getAiSettings()
    if (!settings.apiKey) {
      return staticReply(job, deps, 'The AI assistant is not configured yet — an API key is missing in the settings.')
    }
    const scope = resolveQaScope(job.groupJid)
    // no reachable group beyond the question group itself (nothing linked, or
    // only vanished groups / childless communities): tell the admin, spend nothing
    if (!scope.groupJids.some(j => j !== job.groupJid)) {
      return staticReply(job, deps, 'No groups are linked for me to report on yet. Link groups or a community on the group page in the admin panel.')
    }

    await checkDailyLimit(job, deps, settings.dailyLimit, now)

    void deps.setComposing?.(job.groupJid)?.catch(() => { /* presence is best-effort */ })

    const provider = deps.createProvider({ apiKey: settings.apiKey, model: settings.model })
    const botLid = bareId(getBotUser()?.lid ?? getBotUser()?.jid ?? 'unknown')
    const values = { timezone: settings.timezone, botlid: botLid }
    const system = buildSystemPrompt(scope, now(), settings, values)
    const tools = loadToolDeclarations(values)
    const messages = buildThreadHistory(job)
    const historyTurns = messages.length
    const { firstTurn, contextChars } = buildFirstUserTurn(job, question, scope, settings, now)
    messages.push({ role: 'user', text: firstTurn })
    const deadline = now() + QA_JOB_TIMEOUT_MS
    let answer: string | null = null

    for (let round = 1; round <= QA_MAX_ROUNDS; round++) {
      if (now() > deadline) throw new Error('Q&A job timed out')
      if (round > 1) await checkDailyLimit(job, deps, settings.dailyLimit, now)

      const started = now()
      const resp = await provider.generate({ system, messages, tools })
      addJobAiUsage(job.id, { calls: 1, tokensIn: resp.usage.tokensIn, tokensOut: resp.usage.tokensOut })
      addJobEvent(job.id, 'ai_call', {
        groupJid: job.groupJid,
        data: {
          round,
          model: settings.model,
          durationMs: now() - started,
          tokensIn: resp.usage.tokensIn,
          tokensOut: resp.usage.tokensOut,
          request: round === 1
            ? { system, question, contextChars, historyTurns, toolNames: tools.map(t => t.name) }
            : { toolResults: 'see tool_call events' },
          response: resp.toolCalls?.length
            ? { toolCalls: resp.toolCalls }
            : { text: (resp.text ?? '').slice(0, 4_000) },
        },
      })

      if (resp.toolCalls?.length) {
        messages.push({ role: 'assistant', text: resp.text, toolCalls: resp.toolCalls, raw: resp.raw })
        for (const call of resp.toolCalls) {
          const executed = executeQaTool(call.name, call.args, { scope, timezone: settings.timezone, nowMs: now })
          addJobEvent(job.id, 'tool_call', {
            groupJid: job.groupJid,
            data: {
              name: call.name,
              args: call.args,
              resultChars: executed.resultChars,
              ...(executed.resultChars <= TOOL_RESULT_LOG_MAX ? { result: executed.result } : {}),
            },
          })
          messages.push({ role: 'tool', name: call.name, result: executed.result })
        }
        continue
      }

      const text = resp.text?.trim()
      if (!text) throw new Error('AI returned an empty response')
      answer = text
      break
    }

    if (!answer) throw new Error(`No answer after ${QA_MAX_ROUNDS} tool rounds`)
    if (answer.length > QA_ANSWER_MAX_CHARS) {
      answer = answer.slice(0, QA_ANSWER_MAX_CHARS) + '\n… _(truncated — ask me to narrow it down)_'
    }

    const sentId = await deps.sendReply(job, answer)
    addJobEvent(job.id, 'reply_sent', {
      groupJid: job.groupJid, userJid: job.userJid, messageId: sentId,
      data: { chars: answer.length },
    })
    return { replyMessageId: sentId, answerChars: answer.length }
  }
}

/** onFailure notifier for the worker: short apology, never internals. Stays
 *  silent when the group already got a message for this job (a limit notice,
 *  or the answer itself before a late crash). */
export function buildQaFailureNotifier(deps: Pick<QaResponderDeps, 'sendReply'>) {
  return async function notifyQaFailure(job: BotJob, error: string): Promise<void> {
    if (hasJobEvent(job.id, 'reply_sent') || hasJobEvent(job.id, 'limit_notice')) return
    const busy = /429|quota|rate.?limit|resource.?exhausted|overloaded|unavailable/i.test(error)
    const text = busy
      ? '⚠️ I could not answer — the AI service is busy right now. Please try again in a minute.'
      : '⚠️ Sorry, I could not process that question. The details are in the admin panel job log.'
    try {
      await deps.sendReply(job, text)
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'Failed to send failure notice')
    }
  }
}

async function staticReply(job: BotJob, deps: QaResponderDeps, text: string): Promise<Record<string, unknown>> {
  const sentId = await deps.sendReply(job, text)
  addJobEvent(job.id, 'reply_sent', {
    groupJid: job.groupJid, userJid: job.userJid, messageId: sentId,
    data: { chars: text.length, static: true },
  })
  return { replyMessageId: sentId, answerChars: text.length, static: true }
}

async function checkDailyLimit(job: BotJob, deps: QaResponderDeps, limit: number, now: () => number): Promise<void> {
  if (limit <= 0) return
  if (sumAiCallsToday(now()) < limit) return
  // Always record the cause on the job (this also keeps the failure notifier
  // silent for it); the group message itself is throttled to once per hour.
  addJobEvent(job.id, 'limit_notice', { groupJid: job.groupJid })
  if (now() - lastLimitNoticeAt >= LIMIT_NOTICE_INTERVAL_MS) {
    lastLimitNoticeAt = now()
    try {
      await deps.sendReply(job, `⚠️ The daily AI usage limit (${limit} calls) is reached. Try again tomorrow, or raise the limit in the settings.`)
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'Failed to send limit notice')
    }
  }
  throw new Error(`Daily AI call limit reached (${limit})`)
}

function buildSystemPrompt(scope: QaScope, nowMs: number, settings: AiSettings, values: Record<string, string>): string {
  // The editable template goes first; the structural parts (date anchor, scope
  // listing, per-group instructions) stay in code. INVARIANT: nothing here is
  // an epoch number, and nothing says "Q&A" — that is app jargon.
  const lines: string[] = []
  lines.push(expandPlaceholders(settings.systemPrompt, values))
  lines.push('')
  lines.push(`Current date and time: ${formatDateTime(new Date(nowMs), settings.timezone)} (${settings.timezone}).`)
  lines.push('Groups you can report on:')
  // each concrete group carries the date its data starts — before it, nothing
  // is recorded (communities are containers, their children carry the dates)
  const dataSince = qDataSince(scope.groupJids)
  const sinceDate = (jid: string): string | null => {
    const s = dataSince.get(jid)
    return s ? formatDateTime(s, settings.timezone).slice(0, 10) : null
  }
  for (const e of scope.entries) {
    const d = sinceDate(e.jid)
    if (e.isSelf) {
      lines.push(`- "${e.name}" (${e.jid}) — the group where this question was asked${d ? `, data since ${d}` : ''}`)
    } else if (e.isCommunity) {
      lines.push(`- Community "${e.name}" (${e.jid}), containing:`)
      for (const c of e.children) {
        const cd = sinceDate(c.jid)
        lines.push(`  - "${c.name}" (${c.jid})${cd ? ` — data since ${cd}` : ''}`)
      }
    } else {
      lines.push(`- "${e.name}" (${e.jid})${d ? ` — data since ${d}` : ''}`)
    }
  }
  if (scope.qaInstructions) {
    lines.push('')
    lines.push('Additional instructions from the group administrators:')
    lines.push(expandPlaceholders(scope.qaInstructions, values))
  }
  return lines.join('\n')
}

/** Replay the ancestor exchanges of a follow-up thread as user/model turns.
 *  Each ancestor contributes its question and its final answer text (read from
 *  the activity log via the reply_sent event — referenced, never duplicated),
 *  never its intermediate tool calls. Nearest QA_THREAD_MAX_DEPTH ancestors. */
function buildThreadHistory(job: BotJob): AiChatMessage[] {
  const chain: { q: string; a: string }[] = []
  let parentId = job.payload?.parentJobId
  for (let depth = 0; typeof parentId === 'number' && depth < QA_THREAD_MAX_DEPTH; depth++) {
    const parent = getJob(parentId)
    if (!parent) break
    const q = typeof parent.payload?.text === 'string' ? parent.payload.text : null
    const a = ancestorAnswerText(parent)
    if (q && a) chain.push({ q, a })
    parentId = parent.payload?.parentJobId
  }
  chain.reverse()
  return chain.flatMap((x): AiChatMessage[] => [
    { role: 'user', text: x.q },
    { role: 'assistant', text: x.a },
  ])
}

function ancestorAnswerText(parent: BotJob): string | null {
  const events = getJobEvents(parent.id)
  const reply = events.find(e => e.eventType === 'reply_sent')
  if (reply?.messageId && parent.groupJid) {
    const row = getCreationRecord(parent.groupJid, reply.messageId)
    const text = (row?.metadata as { text?: unknown } | null)?.text
    if (typeof text === 'string' && text) return text
  }
  // Fallback (echo not recorded yet, or the reply was deleted): the last
  // ai_call event carries the answer text capped at 4,000 chars — complete,
  // since answers are capped at QA_ANSWER_MAX_CHARS.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.eventType !== 'ai_call') continue
    const text = (e.data?.response as { text?: unknown } | undefined)?.text
    if (typeof text === 'string' && text) return text
  }
  return null
}

function personString(userJid: string): string {
  const info = qUsersByJids([userJid]).get(userJid)
  const name = info?.name ? ` ${info.name}` : ''
  return `${bareId(userJid)} ${info?.phone ?? '-'}${name}`
}

/** The first user turn: preamble (where / who / when), a bounded recent-
 *  conversation block in the group_messages result format, then the question. */
function buildFirstUserTurn(
  job: BotJob, question: string, scope: QaScope, settings: AiSettings, now: () => number,
): { firstTurn: string; contextChars: number } {
  const groupName = scope.names.get(job.groupJid!) ?? job.groupJid!
  const qRow = job.messageId ? getCreationRecord(job.groupJid!, job.messageId) : undefined
  const askedAt = qRow ? qRow.timestamp : new Date(now()) // activity timestamps are unix seconds
  const parts: string[] = [
    `This question was asked in the group ${job.groupJid} "${groupName}".`,
    `Asked by: ${job.userJid ? personString(job.userJid) : 'unknown'}`,
    `Asked at: ${formatDateTime(askedAt, settings.timezone)}`,
  ]
  const context = buildRecentContext(job, scope, settings, now)
  if (context) {
    parts.push('', 'Recent messages in this group (oldest first, in the group_messages result format), for context:', context)
  }
  parts.push('', 'The question:', question)
  return { firstTurn: parts.join('\n'), contextChars: context?.length ?? 0 }
}

/** The last QA_CONTEXT_MESSAGES messages of the question group, none older
 *  than QA_CONTEXT_MAX_AGE_MS — anything older must be queried via tools.
 *  Reuses the group_messages executor so rendering and the byte cap can never
 *  drift from what the tools return. */
function buildRecentContext(job: BotJob, scope: QaScope, settings: AiSettings, now: () => number): string | null {
  try {
    const from = formatDateTime(new Date(now() - QA_CONTEXT_MAX_AGE_MS), settings.timezone)
    const { result } = executeQaTool('group_messages', {
      group_jids: [job.groupJid!], from, limit: QA_CONTEXT_MESSAGES, order: 'desc',
    }, { scope, timezone: settings.timezone, nowMs: now })
    const parsed = JSON.parse(result) as { error?: unknown; messages?: { id?: unknown }[] }
    if (parsed.error || !Array.isArray(parsed.messages)) return null
    const items = parsed.messages.filter(m => m.id !== job.messageId).reverse()
    if (!items.length) return null
    return JSON.stringify(items)
  } catch (err) {
    logger.warn({ err, jobId: job.id }, 'Failed to build recent context block')
    return null
  }
}
