import type { BotJob, BotTrigger } from '../db/schema.js'
import { AI_CALL_TIMEOUT_MS, type AiChatMessage, type AiProvider, type AiToolCall } from '../ai/provider.js'
import { getAiSettings, expandPlaceholders, type AiSettings } from '../ai/settings.js'
import { loadToolDeclarations } from '../ai/tools/loader.js'
import { executeQaTool } from '../ai/tools/executors.js'
import {
  AI_BUSY_RE, ERROR_TEXT, TriggerGoneError, TriggerJobError, errorTextFor, renderErrorTemplate,
} from '../triggers/errors.js'
import { parseAiAnswer, SEND_ANSWER_SCHEMA_WITH_TOOLS } from '../triggers/ai-answer.js'
import { QA_ANSWER_SPEC } from '../triggers/qa/answer.js'
import { DEFAULT_QA_SYSTEM_PROMPT, QA_DEFAULT_ERROR_TEMPLATE } from '../triggers/qa/defaults.js'
import { qaTriggerType, type QaTriggerConfig } from '../triggers/qa/type.js'
import { resolveTenantScope, type QaScope } from './scope.js'
import { getBotUser } from '../whatsapp/handlers/connection.js'
import { getCreationRecord } from '../db/queries/activity.js'
import { getJob, addJobAiUsage, addJobEvent, getJobEvents, hasJobEvent, sumAiCallsToday } from '../db/queries/jobs.js'
import { getTenantIdForGroup } from '../db/queries/tenants.js'
import { getTrigger } from '../db/queries/triggers.js'
import { getGroup } from '../db/queries/groups.js'
import { qUsersByJids, qDataSince } from '../db/queries/group-tools.js'
import { formatDateTime } from '../utils/time.js'
import type { JobHandler } from './worker.js'
import { logger } from '../utils/logger.js'

export const QA_MAX_ROUNDS = 8
/** Time budget for the tool rounds. Not a hard stop: when it runs low, the
 *  next round is the last one, and that round may run past it. */
export const QA_JOB_TIMEOUT_MS = 60_000
/** With less time than this left, the next round is the last one. Equal to
 *  one AI call's timeout, so every tool round ends within the budget and the
 *  whole job stays well inside the worker's watchdog. */
export const QA_FINAL_ROUND_RESERVE_MS = AI_CALL_TIMEOUT_MS
export const QA_CONTEXT_MESSAGES = 20
export const QA_CONTEXT_MAX_AGE_MS = 48 * 3600_000
export const QA_THREAD_MAX_DEPTH = 10
export const QA_ANSWER_MAX_CHARS = 3_500
export const TOOL_RESULT_LOG_MAX = 2_000
/** Longest question text put into the error template's {{message}}. */
export const ERROR_MESSAGE_TEXT_MAX = 200

export interface QaResponderDeps {
  createProvider: (opts: { apiKey: string; model: string }) => AiProvider
  sendReply: (job: BotJob, text: string) => Promise<string | null>
  setComposing?: (groupJid: string) => Promise<void>
  nowMs?: () => number // injectable clock for tests
}

/** Ends the last round's question: no tools are sent, so the model must answer. */
const FINAL_ROUND_NOTE = 'You cannot call tools any more. Answer now with the JSON object described in the answer format, '
  + 'using only the results above. If something is still missing, say briefly what in output.'

function bareId(jid: string): string {
  return jid.split(':')[0].split('@')[0]
}

/** The trigger that created the job; null when it was deleted since, or the
 *  job is from before triggers existed. */
function jobTrigger(job: BotJob): BotTrigger | null {
  return job.triggerId === null ? null : getTrigger(job.triggerId)
}

/** The job's trigger, its settings, and the groups of its tenant. A job whose
 *  trigger is gone, switched off, set to another Q&A group, or no longer in
 *  the same tenant as the job's group fails quietly: TriggerGoneError posts nothing. */
export function loadQaTrigger(job: BotJob): { trigger: BotTrigger; config: QaTriggerConfig; scope: QaScope } {
  const trigger = jobTrigger(job)
  if (!trigger) throw new TriggerGoneError(`The trigger of this job (${job.triggerId ?? 'none'}) no longer exists`)
  if (!trigger.enabled) throw new TriggerGoneError('The trigger was switched off')
  const config = qaTriggerType.normalize(trigger.config)
  if (config.qaGroupJid !== job.groupJid) throw new TriggerGoneError("The trigger's Q&A group was changed")
  if (getTenantIdForGroup(job.groupJid ?? '') !== trigger.tenantId) {
    throw new TriggerGoneError("The group is no longer in this trigger's tenant")
  }
  return {
    trigger,
    config,
    scope: resolveTenantScope(trigger.tenantId, job.groupJid ?? ''),
  }
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

    const { config, scope } = loadQaTrigger(job)
    const settings = getAiSettings()
    if (!settings.apiKey) throw new TriggerJobError(ERROR_TEXT.noApiKey)
    // no reachable group beyond the question group itself (none in the tenant,
    // or only vanished groups / childless communities): spend nothing
    if (!scope.groupJids.some(j => j !== job.groupJid)) throw new TriggerJobError(ERROR_TEXT.noOtherGroups)

    checkDailyLimit(settings.dailyLimit, now)

    void deps.setComposing?.(job.groupJid)?.catch(() => { /* presence is best-effort */ })

    const provider = deps.createProvider({ apiKey: settings.apiKey, model: settings.model })
    const botLid = bareId(getBotUser()?.lid ?? getBotUser()?.jid ?? 'unknown')
    const values = { timezone: settings.timezone, botlid: botLid }
    const system = buildSystemPrompt(scope, now(), settings, config, values)
    const tools = loadToolDeclarations(values)
    const messages = buildThreadHistory(job)
    const historyTurns = messages.length
    const { firstTurn, contextChars } = buildFirstUserTurn(job, question, scope, settings, now)
    messages.push({ role: 'user', text: firstTurn })
    const deadline = now() + QA_JOB_TIMEOUT_MS
    let answer: string | null = null
    let invalidOnToolRound = false

    for (let round = 1; round <= QA_MAX_ROUNDS; round++) {
      if (round > 1) checkDailyLimit(settings.dailyLimit, now)
      // the last round sends no tools, so the model has to answer
      const toolsOff = round === QA_MAX_ROUNDS ? 'last round'
        : deadline - now() < QA_FINAL_ROUND_RESERVE_MS ? 'time almost up'
        : invalidOnToolRound ? 'invalid answer'
        : null

      const started = now()
      const resp = await provider.generate(toolsOff
        ? { system, messages: buildFinalRoundMessages(messages, historyTurns), tools: [], responseSchema: QA_ANSWER_SPEC.modelSchema }
        : { system, messages, tools, ...(SEND_ANSWER_SCHEMA_WITH_TOOLS ? { responseSchema: QA_ANSWER_SPEC.modelSchema } : {}) })
      addJobAiUsage(job.id, { calls: 1, tokensIn: resp.usage.tokensIn, tokensOut: resp.usage.tokensOut })
      addJobEvent(job.id, 'ai_call', {
        groupJid: job.groupJid,
        data: {
          round,
          model: settings.model,
          durationMs: now() - started,
          ...(toolsOff ? { toolsOff } : {}),
          tokensIn: resp.usage.tokensIn,
          tokensOut: resp.usage.tokensOut,
          request: round === 1
            ? { system, question, contextChars, historyTurns, toolNames: tools.map(t => t.name) }
            : { toolResults: toolsOff ? 'given as text in the question, no tools sent' : 'see tool_call events' },
          response: resp.toolCalls?.length
            ? { toolCalls: resp.toolCalls }
            : { text: (resp.text ?? '').slice(0, 4_000) },
        },
      })

      if (resp.toolCalls?.length && !toolsOff) {
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

      const parsed = parseAiAnswer(resp.text, QA_ANSWER_SPEC)
      if (parsed?.error) throw new TriggerJobError(parsed.errormessage?.trim() || ERROR_TEXT.aiCouldNotAnswer)
      const output = parsed?.output?.trim()
      if (output) {
        answer = output
        break
      }
      // prose, an empty text or a blank output: on a tool round the next round
      // is the final one (tools off, schema on); on the final round we give up
      if (!toolsOff) {
        invalidOnToolRound = true
        continue
      }
      const why = !resp.text?.trim() ? (resp.toolCalls?.length ? 'the AI still asked for tools' : 'the AI returned no text')
        : 'the text is not a valid JSON answer'
      throw new TriggerJobError(ERROR_TEXT.invalidAnswer, `No valid answer on the final round: ${why}`)
    }

    // unreachable: the final round either answers or throws
    if (!answer) throw new Error('No answer from the AI')
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

/** The last round's conversation. Gemini keeps calling tools, even made-up
 *  ones, when the history is full of tool calls, so those calls and their
 *  results are folded into the question as plain text. */
export function buildFinalRoundMessages(messages: AiChatMessage[], historyTurns: number): AiChatMessage[] {
  const first = messages[historyTurns] as Extract<AiChatMessage, { role: 'user' }>
  const results: string[] = []
  let calls: AiToolCall[] = []
  for (const m of messages.slice(historyTurns + 1)) {
    if (m.role === 'assistant') {
      calls = [...(m.toolCalls ?? [])]
    } else if (m.role === 'tool') {
      // results follow their calls in order
      const call = calls.shift()
      results.push(`${results.length + 1}. ${m.name} ${JSON.stringify(call?.args ?? {})}\n${m.result}`)
    }
  }
  const parts = [first.text]
  if (results.length) parts.push('You already called tools for this question. Their results:', results.join('\n\n'))
  parts.push(FINAL_ROUND_NOTE)
  return [...messages.slice(0, historyTurns), { role: 'user', text: parts.join('\n\n') }]
}

/** The request never got a proper answer: network failure, timeout, or the
 *  WhatsApp connection dropped (Baileys errors) while sending the reply. */
const NETWORK_RE = /fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timed out|timeout|abort|Connection (Closed|Terminated|was lost)/i

/** Worker retry policy: only errors that another attempt can fix. Anything
 *  else (a bad request, an empty answer, the daily limit) would fail the same
 *  way again and only cost more. */
export function isTransientAiError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status
  if (typeof status === 'number') return status === 429 || status >= 500
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return AI_BUSY_RE.test(text) || NETWORK_RE.test(text)
}

/** onFailure notifier for the worker: posts the trigger's error template as a
 *  reply to the question, with a short {{error}} text, never internals. Stays
 *  silent when the answer was already sent (a late crash), or when the job's
 *  trigger is gone. */
export function buildTriggerErrorNotifier(deps: Pick<QaResponderDeps, 'sendReply'>) {
  return async function notifyTriggerError(job: BotJob, error: string, err: unknown): Promise<void> {
    if (hasJobEvent(job.id, 'reply_sent') || err instanceof TriggerGoneError) return
    const trigger = jobTrigger(job)
    if (!trigger) return
    const config = qaTriggerType.normalize(trigger.config)
    const question = typeof job.payload?.text === 'string' ? job.payload.text : ''
    const text = renderErrorTemplate(config.errorTemplate.trim() || QA_DEFAULT_ERROR_TEMPLATE, {
      error: errorTextFor(err, error),
      trigger: trigger.name,
      group: (job.groupJid && getGroup(job.groupJid)?.name) || job.groupJid || '',
      user: job.userJid ? '@' + bareId(job.userJid) : '',
      message: question.slice(0, ERROR_MESSAGE_TEXT_MAX),
    })
    try {
      const messageId = await deps.sendReply(job, text)
      addJobEvent(job.id, 'error_sent', { groupJid: job.groupJid, messageId })
    } catch (sendErr) {
      logger.error({ err: sendErr, jobId: job.id }, 'Failed to send the error message')
    }
  }
}

/** Over the limit every question fails with its own error post: each one is
 *  a person waiting. */
function checkDailyLimit(limit: number, now: () => number): void {
  if (limit <= 0) return
  if (sumAiCallsToday(now()) < limit) return
  throw new TriggerJobError(ERROR_TEXT.dailyLimit(limit))
}

function buildSystemPrompt(
  scope: QaScope, nowMs: number, settings: AiSettings, config: QaTriggerConfig, values: Record<string, string>,
): string {
  // The editable prompt goes first; the structural parts (date anchor, scope
  // listing, the administrators' instructions, the answer format) stay in code.
  // INVARIANT: nothing here is an epoch number, and nothing says "Q&A" — that
  // is app jargon.
  const lines: string[] = []
  lines.push(expandPlaceholders(config.prompt.trim() || DEFAULT_QA_SYSTEM_PROMPT, values))
  lines.push('')
  lines.push(`Current date and time: ${formatDateTime(new Date(nowMs), settings.timezone)} (${settings.timezone}).`)
  // the last round has tools off, so one fewer round can call them
  lines.push(`You can call tools in up to ${QA_MAX_ROUNDS - 1} rounds, then you must answer. `
    + 'In one round you can call several tools at once: do that whenever the calls do not depend on each other.')
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
  const instructions = config.instructions.trim()
  if (instructions) {
    lines.push('')
    lines.push('Additional instructions from the group administrators:')
    lines.push(expandPlaceholders(instructions, values))
  }
  // last: the code reads the answer in this format
  lines.push('')
  lines.push(QA_ANSWER_SPEC.formatSection)
  return lines.join('\n')
}

/** Replay the ancestor exchanges of a follow-up thread as user/model turns.
 *  Each ancestor contributes its question and its final answer text (read from
 *  the activity log via the reply_sent event — referenced, never duplicated),
 *  never its intermediate tool calls. The answer is replayed in the JSON answer
 *  format, so the model sees its own format. Nearest QA_THREAD_MAX_DEPTH
 *  ancestors. */
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
    { role: 'assistant', text: JSON.stringify({ error: false, output: x.a }) },
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
  // ai_call event carries the answer text capped at 4,000 chars — the JSON
  // answer, or the plain answer for jobs from before JSON answers.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.eventType !== 'ai_call') continue
    const text = (e.data?.response as { text?: unknown } | undefined)?.text
    if (typeof text === 'string' && text) return parseAiAnswer(text, QA_ANSWER_SPEC)?.output || text
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
