import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMember, seedMessage } from '../helpers/fixtures.js'
import { fakeProvider } from '../helpers/fake-provider.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { updateGroupQaConfig } from '../../src/db/queries/groups.js'
import { setSetting } from '../../src/db/queries/settings.js'
import { insertJob, getJob, getJobEvents, addJobEvent, addJobAiUsage } from '../../src/db/queries/jobs.js'
import {
  createQaAnswerHandler, buildQaFailureNotifier, resetLimitNoticeForTests,
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
    await expect(makeHandler(provider)(makeJob('q2'))).rejects.toThrow(/daily/i)
    expect(sent.length).toBe(1) // throttled: no second notice within the hour
    expect(provider.calls.length).toBe(0)
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

  it('fails after QA_MAX_ROUNDS of tool calls', async () => {
    const provider = fakeProvider(Array.from({ length: QA_MAX_ROUNDS + 1 }, () => ({ toolCalls: [{ name: 'group_list', args: {} }] })))
    await expect(makeHandler(provider)(makeJob())).rejects.toThrow(/rounds/i)
    expect(provider.calls.length).toBe(QA_MAX_ROUNDS)
  })

  it('fails on an empty provider response', async () => {
    const provider = fakeProvider([{}])
    await expect(makeHandler(provider)(makeJob())).rejects.toThrow(/empty/i)
  })

  it('fails when the wall clock budget is exhausted', async () => {
    // The provider call itself consumes the whole budget, so the round-2
    // deadline check fires. (Advancing the clock from the test body would be
    // too late: the deadline is computed before the test regains control.)
    let t = NOW_MS
    const provider: AiProvider = {
      async generate() {
        t += 61_000
        return { toolCalls: [{ name: 'group_list', args: {} }], usage: { tokensIn: 1, tokensOut: 1 } }
      },
    }
    await expect(makeHandler(provider, () => t)(makeJob())).rejects.toThrow(/timed out/i)
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
