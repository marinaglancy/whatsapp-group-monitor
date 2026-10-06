import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMember, seedMessage } from '../helpers/fixtures.js'
import { fakeProvider } from '../helpers/fake-provider.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { updateGroupQaConfig } from '../../src/db/queries/groups.js'
import { setSetting } from '../../src/db/queries/settings.js'
import { insertJob, getJob, getJobEvents, addJobEvent, addJobAiUsage } from '../../src/db/queries/jobs.js'
import {
  createQaAnswerHandler, buildQaFailureNotifier, resetLimitNoticeForTests, isTransientAiError, buildFinalRoundMessages,
  QA_MAX_ROUNDS, QA_ANSWER_MAX_CHARS, QA_THREAD_MAX_DEPTH,
} from '../../src/bot/responder.js'
import type { AiProvider } from '../../src/ai/provider.js'
import type { BotJob } from '../../src/db/schema.js'

const BOT_JID = '15550001234@s.whatsapp.net'
const BOT_LID = '99887766001@lid'
const NOW_S = Math.floor(Date.now() / 1000)
const NOW_MS = NOW_S * 1000

let dbs: ReturnType<typeof setupTestDbs>
let sent: { text: string; jobId: number }[]
let composing: string[]

beforeEach(() => {
  dbs = setupTestDbs()
  resetLimitNoticeForTests()
  sent = []
  composing = []
  updateBotUser({ id: BOT_JID, lid: BOT_LID } as never)
  seedGroup('qa@g.us', 'Admins')
  seedGroup('a@g.us', 'Alpha')
  seedUser('asker@lid', 'Anna', '4917612345678')
  seedMember('a@g.us', 'asker@lid')
  seedMember('qa@g.us', 'asker@lid')
  updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['a@g.us'] })
  setSetting('gemini_api_key', 'sk-test')
})
afterEach(() => { dbs.cleanup() })

function makeJob(text = 'how many messages in September?', payloadExtra: Record<string, unknown> = {}): BotJob {
  const qId = seedMessage('qa@g.us', 'asker@lid', text, NOW_S - 5)
  const id = insertJob({
    jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: qId,
    payload: { text, ...payloadExtra }, runAt: NOW_S, expiresAt: NOW_S + 600,
  })!
  return getJob(id)!
}

function makeHandler(provider: AiProvider, nowMs: () => number = () => NOW_MS) {
  return createQaAnswerHandler({
    createProvider: () => provider,
    sendReply: async (job, text) => { sent.push({ text, jobId: job.id }); return `SENT${sent.length}` },
    setComposing: async (groupJid) => { composing.push(groupJid) },
    nowMs,
  })
}

describe('qa_answer handler', () => {
  it('runs the tool loop, logs events, sums usage, sends the reply (happy path)', async () => {
    const provider = fakeProvider([
      { toolCalls: [{ name: 'group_list', args: {} }], usage: { tokensIn: 100, tokensOut: 10 } },
      { text: 'There were *0* messages.', usage: { tokensIn: 200, tokensOut: 20 } },
    ])
    const job = makeJob()
    const result = await makeHandler(provider)(job)

    expect(sent).toEqual([{ text: 'There were *0* messages.', jobId: job.id }])
    expect(result).toMatchObject({ replyMessageId: 'SENT1', answerChars: sent[0].text.length })
    expect(composing).toEqual(['qa@g.us'])
    const events = getJobEvents(job.id)
    expect(events.map(e => e.eventType)).toEqual(['ai_call', 'tool_call', 'ai_call', 'reply_sent'])
    const req = events[0].data!.request as Record<string, unknown>
    expect(req.question).toBe('how many messages in September?')
    expect(req.system as string).toContain('Alpha')
    expect(events[1].data).toMatchObject({ name: 'group_list' })
    expect(events[3].messageId).toBe('SENT1')
    const fresh = getJob(job.id)!
    expect(fresh.aiCalls).toBe(2)
    expect(fresh.aiTokensIn).toBe(300)
    expect(fresh.aiTokensOut).toBe(30)
  })

  it('passes the provider raw content back on assistant turns (thought signatures)', async () => {
    const raw = { role: 'model', parts: [{ functionCall: { name: 'group_list', args: {} }, thoughtSignature: 'SIG' }] }
    const provider = fakeProvider([
      { toolCalls: [{ name: 'group_list', args: {} }], raw },
      { text: 'done' },
    ])
    await makeHandler(provider)(makeJob())
    const assistantTurn = provider.calls[1].messages.find(m => m.role === 'assistant') as { raw?: unknown }
    expect(assistantTurn.raw).toBe(raw)
  })

  it('expands placeholders in tools and identifies the bot account in the system prompt', async () => {
    setSetting('timezone', 'Europe/Lisbon')
    const provider = fakeProvider([{ text: 'ok' }])
    await makeHandler(provider)(makeJob())
    const call = provider.calls[0]
    expect(call.tools.length).toBe(5)
    expect(JSON.stringify(call.tools)).not.toContain('{{')
    expect(JSON.stringify(call.tools)).toContain('Europe/Lisbon')
    expect(call.system).toContain('99887766001') // {{botlid}} expanded to lid digits
    expect(call.system).not.toContain('{{botlid}}')
    expect(call.system).toContain('the group where this question was asked')
  })

  it('tells the model how many rounds of tool calls it has', async () => {
    const provider = fakeProvider([{ text: 'ok' }])
    await makeHandler(provider)(makeJob())
    // must follow the real limit, or the model plans for the wrong budget
    // the last round has tools off, so one fewer round can call them
    expect(provider.calls[0].system).toContain(`${QA_MAX_ROUNDS - 1} rounds`)
  })

  it('annotates every scope group with its data-since date', async () => {
    seedGroup('comm@g.us', 'Hive', { isCommunity: true })
    seedGroup('c@g.us', 'Child', { parentCommunityJid: 'comm@g.us' })
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['a@g.us', 'comm@g.us'] })
    seedMessage('a@g.us', 'asker@lid', 'old alpha message', NOW_S - 5 * 86400)
    const provider = fakeProvider([{ text: 'ok' }])
    await makeHandler(provider)(makeJob())
    const sys = provider.calls[0].system
    const alphaSince = new Date((NOW_S - 5 * 86400) * 1000).toISOString().slice(0, 10)
    expect(sys).toContain(`- "Alpha" (a@g.us) — data since ${alphaSince}`)
    // the question group keeps its marker and gains the date
    expect(sys).toMatch(/"Admins" \(qa@g\.us\) — the group where this question was asked, data since \d{4}-\d{2}-\d{2}/)
    // a silent child group falls back to when the monitor first saw it
    expect(sys).toMatch(/ {2}- "Child" \(c@g\.us\) — data since \d{4}-\d{2}-\d{2}/)
    // the community container itself carries no date
    expect(sys).toMatch(/- Community "Hive" \(comm@g\.us\), containing:\n/)
  })

  it('builds the first user turn: preamble, recent context, question', async () => {
    seedMessage('qa@g.us', BOT_LID, 'Earlier answer', NOW_S - 100)
    seedMessage('qa@g.us', 'asker@lid', 'Earlier question', NOW_S - 120)
    const provider = fakeProvider([{ text: 'Follow-up answer.' }])
    const job = makeJob('and for August?')
    await makeHandler(provider)(job)
    const msgs = provider.calls[0].messages
    expect(msgs.length).toBe(1)
    const text = (msgs[0] as { text: string }).text
    expect(msgs[0].role).toBe('user')
    expect(text).toContain('This question was asked in the group qa@g.us "Admins"')
    expect(text).toContain('99887766001') // bot message author (lid digits) in the context block
    expect(text).toContain('Earlier answer')
    expect(text).toContain('Earlier question')
    expect(text).toContain('and for August?')
    expect(text).toContain('asker 4917612345678 Anna') // asker person string
    expect(text).not.toContain(job.messageId!) // the question is not duplicated inside the context block
    expect(text).not.toMatch(/Q&A/i)
    expect(text).toMatch(/Asked at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
    // epoch numbers must never surface in model-visible text
    const questionTs = NOW_S - 5
    for (const blob of [text, provider.calls[0].system]) {
      expect(blob).not.toContain(String(questionTs))
      expect(blob).not.toContain(String(questionTs * 1000))
    }
  })

  it('limits the recent context block to the last 48 hours', async () => {
    seedMessage('qa@g.us', 'asker@lid', 'ancient chatter', NOW_S - 49 * 3600)
    seedMessage('qa@g.us', 'asker@lid', 'fresh chatter', NOW_S - 3600)
    const provider = fakeProvider([{ text: 'ok' }])
    await makeHandler(provider)(makeJob())
    const text = (provider.calls[0].messages[0] as { text: string }).text
    expect(text).toContain('fresh chatter')
    expect(text).not.toContain('ancient chatter')
  })

  it('replays the ancestor exchange for a follow-up (parentJobId)', async () => {
    const pq = seedMessage('qa@g.us', 'asker@lid', 'first question', NOW_S - 200)
    const parentId = insertJob({
      jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: pq,
      payload: { text: 'first question' }, runAt: NOW_S - 200, expiresAt: NOW_S + 600,
    })!
    const aid = seedMessage('qa@g.us', BOT_LID, 'The first answer', NOW_S - 190)
    addJobEvent(parentId, 'reply_sent', { groupJid: 'qa@g.us', messageId: aid, data: { chars: 16 } })

    const provider = fakeProvider([{ text: 'Second answer.' }])
    await makeHandler(provider)(makeJob('and details?', { parentJobId: parentId }))
    const msgs = provider.calls[0].messages
    expect(msgs.length).toBe(3)
    expect(msgs[0]).toEqual({ role: 'user', text: 'first question' })
    expect(msgs[1]).toEqual({ role: 'assistant', text: 'The first answer' })
    expect(msgs[2].role).toBe('user')
    expect((msgs[2] as { text: string }).text).toContain('and details?')
  })

  it('caps the replayed thread at QA_THREAD_MAX_DEPTH nearest ancestors', async () => {
    let parentJobId: number | undefined
    for (let i = 1; i <= QA_THREAD_MAX_DEPTH + 2; i++) {
      const q = seedMessage('qa@g.us', 'asker@lid', `q${i}`, NOW_S - 1000 + i * 10)
      const id = insertJob({
        jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: q,
        payload: { text: `q${i}`, ...(parentJobId ? { parentJobId } : {}) },
        runAt: NOW_S, expiresAt: NOW_S + 600,
      })!
      const a = seedMessage('qa@g.us', BOT_LID, `a${i}`, NOW_S - 995 + i * 10)
      addJobEvent(id, 'reply_sent', { groupJid: 'qa@g.us', messageId: a, data: { chars: 2 } })
      parentJobId = id
    }
    const provider = fakeProvider([{ text: 'done' }])
    await makeHandler(provider)(makeJob('latest?', { parentJobId }))
    const msgs = provider.calls[0].messages
    expect(msgs.length).toBe(QA_THREAD_MAX_DEPTH * 2 + 1)
    // nearest ancestors kept: the oldest replayed turn is q3 of the 12-long chain
    expect((msgs[0] as { text: string }).text).toBe('q3')
  })

  it('appends per-group custom instructions to the system prompt', async () => {
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['a@g.us'], instructions: 'Always answer in Russian.' })
    const provider = fakeProvider([{ text: 'Хорошо.' }])
    await makeHandler(provider)(makeJob())
    expect(provider.calls[0].system).toContain('Additional instructions from the group administrators:')
    expect(provider.calls[0].system).toContain('Always answer in Russian.')
  })

  it('replies statically without any AI call when no key is configured', async () => {
    setSetting('gemini_api_key', '')
    const provider = fakeProvider([])
    const result = await makeHandler(provider)(makeJob())
    expect(provider.calls.length).toBe(0)
    expect(sent[0].text).toMatch(/not configured/i)
    expect((result as { static: boolean }).static).toBe(true)
  })

  it('replies statically when nothing is linked (self-only scope)', async () => {
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: [] })
    const provider = fakeProvider([])
    await makeHandler(provider)(makeJob())
    expect(provider.calls.length).toBe(0)
    expect(sent[0].text).toMatch(/no groups are linked/i)
  })

  it('replies statically when the only link is a community with no reachable groups', async () => {
    seedGroup('empty-comm@g.us', 'Ghost Town', { isCommunity: true })
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['empty-comm@g.us'] })
    const provider = fakeProvider([])
    await makeHandler(provider)(makeJob())
    expect(provider.calls.length).toBe(0)
    expect(sent[0].text).toMatch(/no groups are linked/i)
  })

  it('does not double-send after a crash between send and completion', async () => {
    const job = makeJob()
    addJobEvent(job.id, 'reply_sent', { messageId: 'OLD' })
    const provider = fakeProvider([])
    const result = await makeHandler(provider)(job)
    expect(sent.length).toBe(0)
    expect(provider.calls.length).toBe(0)
    expect(result).toMatchObject({ note: expect.stringContaining('already') })
  })

  it('enforces the daily limit with an hourly-throttled notice', async () => {
    setSetting('ai_daily_limit', '3')
    const spent = makeJob('old question')
    addJobAiUsage(spent.id, { calls: 3, tokensIn: 1, tokensOut: 1 })
    const provider = fakeProvider([])
    await expect(makeHandler(provider)(makeJob('q1'))).rejects.toThrow(/daily/i)
    expect(sent.length).toBe(1) // the notice
    const q2 = makeJob('q2')
    await expect(makeHandler(provider)(q2)).rejects.toThrow(/daily/i)
    expect(sent.length).toBe(1) // throttled: no second notice within the hour
    expect(provider.calls.length).toBe(0)
    // ...but the throttled job still records WHY it failed, so the failure
    // notifier stays silent instead of sending a misleading generic apology
    const notify = buildQaFailureNotifier({ sendReply: async (job, text) => { sent.push({ text, jobId: job.id }); return null } })
    await notify(getJob(q2.id)!, 'Daily AI call limit reached (3)')
    expect(sent.length).toBe(1)
  })

  it('stops mid-loop when the limit is crossed by its own calls', async () => {
    setSetting('ai_daily_limit', '1')
    const provider = fakeProvider([
      { toolCalls: [{ name: 'group_list', args: {} }] },
      { text: 'never reached' },
    ])
    await expect(makeHandler(provider)(makeJob())).rejects.toThrow(/daily/i)
    expect(provider.calls.length).toBe(1)
    expect(sent.length).toBe(1) // limit notice
  })

  it('feeds tool errors back to the model and recovers', async () => {
    const provider = fakeProvider([
      { toolCalls: [{ name: 'group_messages', args: { from: '2026-09-30', to: '2026-09-01' } }] },
      { text: 'Recovered fine.' },
    ])
    await makeHandler(provider)(makeJob())
    const toolMsg = provider.calls[1].messages.find(m => m.role === 'tool') as { result: string }
    expect(toolMsg.result).toContain('error')
    expect(sent[0].text).toBe('Recovered fine.')
  })

  const toolRound = () => ({ toolCalls: [{ name: 'group_list', args: {} }] })

  const hasTools = (c: { tools: unknown[] }) => c.tools.length > 0

  it('sends no tools on the last round, so the model has to answer', async () => {
    const provider = fakeProvider([
      ...Array.from({ length: QA_MAX_ROUNDS - 1 }, toolRound),
      { text: 'Here is what I found so far.' },
    ])
    await makeHandler(provider)(makeJob())
    expect(provider.calls.map(hasTools)).toEqual([...Array(QA_MAX_ROUNDS - 1).fill(true), false])
    expect(sent[0].text).toBe('Here is what I found so far.')
  })

  it('gives the last round the tool results as plain text, with no tool calls left in the conversation', async () => {
    const provider = fakeProvider([
      { toolCalls: [{ name: 'group_list', args: { limit: 5 } }] },
      ...Array.from({ length: QA_MAX_ROUNDS - 2 }, toolRound),
      { text: 'ok' },
    ])
    await makeHandler(provider)(makeJob())
    const firstTurn = (provider.calls[0].messages.at(-1) as { text: string }).text
    const last = provider.calls.at(-1)!
    // a conversation full of tool calls is what made Gemini keep calling tools
    expect(last.messages.some(m => m.role === 'tool' || (m.role === 'assistant' && m.toolCalls?.length))).toBe(false)
    const final = last.messages.at(-1) as { role: string; text: string }
    expect(final.role).toBe('user')
    expect(final.text.startsWith(firstTurn)).toBe(true)
    expect(final.text).toContain('group_list {"limit":5}') // which call
    expect(final.text).toContain('Alpha') // and what it returned
  })

  it('replies honestly instead of failing when the last round still gives no answer', async () => {
    const provider = fakeProvider(Array.from({ length: QA_MAX_ROUNDS }, toolRound))
    const job = makeJob()
    await expect(makeHandler(provider)(job)).rejects.toThrow(/no answer on the last round/i)
    expect(sent.map(m => m.text)).toEqual([expect.stringMatching(/narrower question/i)])
    expect(getJobEvents(job.id).filter(e => e.eventType === 'tool_call').length).toBe(QA_MAX_ROUNDS - 1)
    const replied = getJobEvents(job.id).find(e => e.eventType === 'reply_sent')!
    expect(replied.data).toMatchObject({ fallback: true })
  })

  it('also replies honestly when the last round comes back empty', async () => {
    const provider = fakeProvider([...Array.from({ length: QA_MAX_ROUNDS - 1 }, toolRound), {}])
    const job = makeJob()
    await expect(makeHandler(provider)(job)).rejects.toThrow(/no answer on the last round/i)
    expect(sent.map(m => m.text)).toEqual([expect.stringMatching(/narrower question/i)])
    expect(getJobEvents(job.id).find(e => e.eventType === 'reply_sent')!.data).toMatchObject({ fallback: true })
  })

  it('logs on the job why tools were off', async () => {
    const provider = fakeProvider([...Array.from({ length: QA_MAX_ROUNDS - 1 }, toolRound), { text: 'ok' }])
    const job = makeJob()
    await makeHandler(provider)(job)
    const aiCalls = getJobEvents(job.id).filter(e => e.eventType === 'ai_call')
    expect(aiCalls.map(e => e.data!.toolsOff)).toEqual([...Array(QA_MAX_ROUNDS - 1).fill(undefined), 'last round'])
  })

  it('fails on an empty provider response', async () => {
    const provider = fakeProvider([{}])
    await expect(makeHandler(provider)(makeJob())).rejects.toThrow(/empty/i)
  })

  // Each provider call advances the clock, the way a slow AI call would.
  // (Advancing it from the test body would be too late: the deadline is
  // computed before the test regains control.)
  function slowProvider(script: Parameters<typeof fakeProvider>[0], msPerCall: number, clock: { t: number }) {
    const provider = fakeProvider(script)
    const generate = provider.generate.bind(provider)
    provider.generate = async (req) => { clock.t += msPerCall; return generate(req) }
    return provider
  }

  it('makes the next round the last one when time is almost up', async () => {
    const clock = { t: NOW_MS }
    const provider = slowProvider([toolRound(), { text: 'Answer under time pressure.' }], 50_000, clock)
    const job = makeJob()
    await makeHandler(provider, () => clock.t)(job)
    expect(provider.calls.map(hasTools)).toEqual([true, false])
    expect(sent[0].text).toBe('Answer under time pressure.')
    expect(getJobEvents(job.id).filter(e => e.eventType === 'ai_call').at(-1)!.data!.toolsOff).toBe('time almost up')
  })

  it('keeps tools on while there is plenty of time left', async () => {
    const clock = { t: NOW_MS }
    const provider = slowProvider([toolRound(), toolRound(), { text: 'done' }], 10_000, clock)
    await makeHandler(provider, () => clock.t)(makeJob())
    expect(provider.calls.map(hasTools)).toEqual([true, true, true])
  })

  it('truncates over-long answers with a hint', async () => {
    const provider = fakeProvider([{ text: 'y'.repeat(QA_ANSWER_MAX_CHARS + 500) }])
    await makeHandler(provider)(makeJob())
    expect(sent[0].text.length).toBeLessThanOrEqual(QA_ANSWER_MAX_CHARS + 60)
    expect(sent[0].text).toMatch(/narrow it down/)
  })

  it('does not log oversized tool results into events, only their size', async () => {
    for (let i = 0; i < 30; i++) seedMessage('a@g.us', 'asker@lid', 'z'.repeat(200), NOW_S - 50 + i)
    const provider = fakeProvider([
      { toolCalls: [{ name: 'group_messages', args: { group_jids: ['a@g.us'], from: '2020-01-01', to: '2030-01-01' } }] },
      { text: 'Summarized.' },
    ])
    const job = makeJob()
    await makeHandler(provider)(job)
    const toolEvent = getJobEvents(job.id).find(e => e.eventType === 'tool_call')!
    expect(toolEvent.data!.resultChars as number).toBeGreaterThan(2000)
    expect('result' in toolEvent.data!).toBe(false)
  })
})

describe('failure notifier', () => {
  function makeNotifier() {
    return buildQaFailureNotifier({ sendReply: async (job, text) => { sent.push({ text, jobId: job.id }); return null } })
  }

  it('sends a quota-specific apology on 429-ish errors, generic otherwise', async () => {
    const notify = makeNotifier()
    await notify(makeJob(), 'Error: 429 RESOURCE_EXHAUSTED quota exceeded')
    expect(sent[0].text).toMatch(/busy|try again/i)
    await notify(makeJob('other q'), 'TypeError: boom')
    expect(sent[1].text).toMatch(/could not|sorry/i)
    expect(sent[1].text).not.toContain('TypeError')
  })

  it('does not mistake a line number in the stack for a 429', async () => {
    const notify = makeNotifier()
    await notify(makeJob(), "TypeError: boom\n    at handleQaAnswer (/app/src/bot/responder.ts:429:12)")
    expect(sent[0].text).toMatch(/sorry/i)
  })

  it('stays silent when the group already got a message for this job', async () => {
    const notify = makeNotifier()
    const limited = makeJob('limited q')
    addJobEvent(limited.id, 'limit_notice', {})
    await notify(limited, 'Daily AI call limit reached (3)')
    const answered = makeJob('answered q')
    addJobEvent(answered.id, 'reply_sent', { messageId: 'X' })
    await notify(answered, 'crashed after send')
    expect(sent.length).toBe(0)
  })
})

describe('isTransientAiError', () => {
  // the Gemini SDK throws ApiError: an Error with a numeric HTTP status
  const apiError = (status: number, message: string) => Object.assign(new Error(message), { status })

  it.each([
    ['429 rate limit', true, apiError(429, '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')],
    ['503 overloaded', true, apiError(503, '{"error":{"code":503,"message":"The model is overloaded."}}')],
    ['500 internal', true, apiError(500, '{"error":{"code":500,"status":"INTERNAL"}}')],
    ['400 bad request', false, apiError(400, '{"error":{"code":400,"message":"Function call is missing a thought_signature","status":"INVALID_ARGUMENT"}}')],
    ['400 that mentions "unavailable"', false, apiError(400, '{"error":{"message":"field unavailable in this model"}}')],
    ['network: fetch failed', true, new TypeError('fetch failed')],
    ['network: connection reset', true, Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    // the SDK aborts with a plain controller.abort(), so our 30 s timeout surfaces as this
    ['AI call timeout', true, new DOMException('This operation was aborted', 'AbortError')],
    ['WhatsApp connection closed', true, Object.assign(new Error('Connection Closed'), { isBoom: true, output: { statusCode: 428 } })],
    ['WhatsApp connection lost', true, Object.assign(new Error('Connection was lost'), { isBoom: true, output: { statusCode: 408 } })],
    ['WhatsApp query timeout', true, Object.assign(new Error('Timed Out'), { isBoom: true, output: { statusCode: 408 } })],
    ['daily limit set to 429', false, new Error('Daily AI call limit reached (429)')],
    ['empty answer', false, new Error('AI returned an empty response')],
    ['daily limit', false, new Error('Daily AI call limit reached (300)')],
    ['bad job', false, new Error('qa_answer job has no question text or group')],
    ['code bug', false, new TypeError("Cannot read properties of undefined (reading 'x')")],
  ])('%s → retry: %s', (_label, want, err) => {
    expect(isTransientAiError(err)).toBe(want)
  })
})

describe('buildFinalRoundMessages', () => {
  it('keeps the earlier exchange and folds each call, with its own result, into the question', () => {
    const final = buildFinalRoundMessages([
      { role: 'user', text: 'earlier question' },        // thread history
      { role: 'assistant', text: 'earlier answer' },
      { role: 'user', text: 'THE QUESTION' },            // this job's question
      { role: 'assistant', toolCalls: [{ name: 'a', args: { x: 1 } }, { name: 'b', args: { y: 2 } }] }, // two calls in one round
      { role: 'tool', name: 'a', result: 'RESULT-A' },
      { role: 'tool', name: 'b', result: 'RESULT-B' },
      { role: 'assistant', toolCalls: [{ name: 'c', args: {} }] },
      { role: 'tool', name: 'c', result: 'RESULT-C' },
    ], 2)

    expect(final.slice(0, 2)).toEqual([
      { role: 'user', text: 'earlier question' },
      { role: 'assistant', text: 'earlier answer' },
    ])
    expect(final).toHaveLength(3)
    const last = final[2] as { role: string; text: string }
    expect(last.role).toBe('user')
    expect(last.text.startsWith('THE QUESTION')).toBe(true)
    const order = ['1. a {"x":1}\nRESULT-A', '2. b {"y":2}\nRESULT-B', '3. c {}\nRESULT-C'].map(p => last.text.indexOf(p))
    expect(order.every(i => i > 0)).toBe(true)
    expect([...order].sort((p, q) => p - q)).toEqual(order)
  })
})
