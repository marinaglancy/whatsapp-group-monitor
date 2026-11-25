import type { BotJob } from '../db/schema.js'
import { AI_CALL_TIMEOUT_MS, type AiChatMessage, type AiProvider, type AiToolCall } from '../ai/provider.js'
import type { AiSettings } from '../ai/settings.js'
import { loadToolDeclarations } from '../ai/tools/loader.js'
import { executeQaTool } from '../ai/tools/executors.js'
import { ERROR_TEXT, TriggerJobError } from './errors.js'
import { parseAiAnswer, SEND_ANSWER_SCHEMA_WITH_TOOLS, type AiAnswerBase, type AnswerSpec } from './ai-answer.js'
import type { QaScope } from '../bot/scope.js'
import { addJobAiUsage, addJobEvent, sumAiCallsToday } from '../db/queries/jobs.js'
import { qDataSince } from '../db/queries/group-tools.js'
import { formatDateTime } from '../utils/time.js'

export const AI_MAX_ROUNDS = 8
/** Time budget for the tool rounds. Not a hard stop: when it runs low, the
 *  next round is the last one, and that round may run past it. */
export const AI_JOB_TIMEOUT_MS = 60_000
/** With less time than this left, the next round is the last one. Equal to
 *  one AI call's timeout, so every tool round ends within the budget and the
 *  whole job stays well inside the worker's watchdog. */
export const AI_FINAL_ROUND_RESERVE_MS = AI_CALL_TIMEOUT_MS
export const TOOL_RESULT_LOG_MAX = 2_000

/** Ends the last round's question: no tools are sent, so the model must answer.
 *  The default names Mentions' answer field; other types pass their own note. */
const FINAL_ROUND_NOTE = 'You cannot call tools any more. Answer now with the JSON object described in the answer format, '
  + 'using only the results above. If something is still missing, say briefly what in output.'

export interface AiRunOptions<T extends AiAnswerBase> {
  job: BotJob
  provider: AiProvider
  settings: AiSettings
  system: string
  /** The conversation: the replayed history turns, then the first user turn. */
  messages: AiChatMessage[]
  historyTurns: number
  scope: QaScope
  spec: AnswerSpec<T>
  now: () => number
  /** Values for the {{placeholders}} in the tool declarations. */
  toolValues: Record<string, string>
  /** Extra fields logged on round 1's ai_call event. */
  round1Request: Record<string, unknown>
  /** Whether a valid answer is usable; false is treated like an invalid answer. */
  accept(answer: T): boolean
  /** Ends the last round's question; defaults to Mentions' note. */
  finalRoundNote?: string
}

/** Runs the function-calling loop until the AI gives an accepted answer, and
 *  returns it. Every call is logged on the job (ai_call and tool_call events,
 *  usage). Fails with a TriggerJobError when the AI reports an error, when the
 *  last round has no usable answer, or when the daily limit is reached. */
export async function runAiAnswer<T extends AiAnswerBase>(o: AiRunOptions<T>): Promise<T> {
  const { job, provider, settings, system, messages, historyTurns, scope, spec, now } = o
  const tools = loadToolDeclarations(o.toolValues)
  const deadline = now() + AI_JOB_TIMEOUT_MS
  let invalidOnToolRound = false

  for (let round = 1; round <= AI_MAX_ROUNDS; round++) {
    if (round > 1) checkDailyLimit(settings.dailyLimit, now)
    // the last round sends no tools, so the model has to answer
    const toolsOff = round === AI_MAX_ROUNDS ? 'last round'
      : deadline - now() < AI_FINAL_ROUND_RESERVE_MS ? 'time almost up'
      : invalidOnToolRound ? 'invalid answer'
      : null

    const started = now()
    const resp = await provider.generate(toolsOff
      ? { system, messages: buildFinalRoundMessages(messages, historyTurns, o.finalRoundNote), tools: [], responseSchema: spec.modelSchema }
      : { system, messages, tools, ...(SEND_ANSWER_SCHEMA_WITH_TOOLS ? { responseSchema: spec.modelSchema } : {}) })
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
          ? { system, ...o.round1Request, historyTurns, toolNames: tools.map(t => t.name) }
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

    const parsed = parseAiAnswer(resp.text, spec)
    if (parsed?.error) throw new TriggerJobError(parsed.errormessage?.trim() || ERROR_TEXT.aiCouldNotAnswer)
    if (parsed && o.accept(parsed)) return parsed
    // prose, an empty text or an answer accept refuses: on a tool round the
    // next round is the final one (tools off, schema on); on the final round we give up
    if (!toolsOff) {
      invalidOnToolRound = true
      continue
    }
    const why = !resp.text?.trim() ? (resp.toolCalls?.length ? 'the AI still asked for tools' : 'the AI returned no text')
      : 'the text is not a valid JSON answer'
    throw new TriggerJobError(ERROR_TEXT.invalidAnswer, `No valid answer on the final round: ${why}`)
  }

  // unreachable: the final round either answers or throws
  throw new Error('No answer from the AI')
}

/** The last round's conversation. Gemini keeps calling tools, even made-up
 *  ones, when the history is full of tool calls, so those calls and their
 *  results are folded into the question as plain text. */
export function buildFinalRoundMessages(
  messages: AiChatMessage[], historyTurns: number, note: string = FINAL_ROUND_NOTE,
): AiChatMessage[] {
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
  parts.push(note)
  return [...messages.slice(0, historyTurns), { role: 'user', text: parts.join('\n\n') }]
}

/** Throws the daily-limit error once today's AI calls reach the limit; a
 *  limit of 0 means no limit. */
export function checkDailyLimit(limit: number, now: () => number): void {
  if (limit <= 0) return
  if (sumAiCallsToday(now()) < limit) return
  throw new TriggerJobError(ERROR_TEXT.dailyLimit(limit))
}

/** The system prompt lines that anchor the AI: the current date and time, the
 *  round budget, and the groups it can report on. `selfLabel` describes the
 *  group the job is about. INVARIANT: nothing here is an epoch number. */
export function buildScopeListing(scope: QaScope, nowMs: number, timezone: string, selfLabel: string): string[] {
  const lines: string[] = []
  lines.push(`Current date and time: ${formatDateTime(new Date(nowMs), timezone)} (${timezone}).`)
  // the last round has tools off, so one fewer round can call them
  lines.push(`You can call tools in up to ${AI_MAX_ROUNDS - 1} rounds, then you must answer. `
    + 'In one round you can call several tools at once: do that whenever the calls do not depend on each other.')
  lines.push('Groups you can report on:')
  // each concrete group carries the date its data starts — before it, nothing
  // is recorded (communities are containers, their children carry the dates)
  const dataSince = qDataSince(scope.groupJids)
  const sinceDate = (jid: string): string | null => {
    const s = dataSince.get(jid)
    return s ? formatDateTime(s, timezone).slice(0, 10) : null
  }
  for (const e of scope.entries) {
    const d = sinceDate(e.jid)
    if (e.isSelf) {
      lines.push(`- "${e.name}" (${e.jid}) — ${selfLabel}${d ? `, data since ${d}` : ''}`)
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
  return lines
}
