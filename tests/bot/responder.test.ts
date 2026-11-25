import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMember, seedMessage, seedTenant, seedQaTrigger } from '../helpers/fixtures.js'
import { fakeProvider } from '../helpers/fake-provider.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { setSetting } from '../../src/db/queries/settings.js'
import { setTenantGroups } from '../../src/db/queries/tenants.js'
import { updateTrigger, deleteTrigger, setTriggerEnabled } from '../../src/db/queries/triggers.js'
import { insertJob, getJob, getJobEvents, addJobEvent, addJobAiUsage } from '../../src/db/queries/jobs.js'
import {
  createQaAnswerHandler, buildTriggerErrorNotifier, isTransientAiError, buildFinalRoundMessages,
  QA_MAX_ROUNDS, QA_ANSWER_MAX_CHARS, QA_THREAD_MAX_DEPTH,
} from '../../src/bot/responder.js'
import { QA_ANSWER_SPEC } from '../../src/triggers/qa/answer.js'
import { SEND_ANSWER_SCHEMA_WITH_TOOLS } from '../../src/triggers/ai-answer.js'
import { DEFAULT_QA_SYSTEM_PROMPT, QA_TRIGGER_DEFAULTS } from '../../src/triggers/qa/defaults.js'
import type { QaTriggerConfig } from '../../src/triggers/qa/type.js'
import { TriggerGoneError, TriggerJobError, ERROR_TEXT } from '../../src/triggers/errors.js'
import type { AiProvider } from '../../src/ai/provider.js'
import type { BotJob } from '../../src/db/schema.js'

const BOT_JID = '15550001234@s.whatsapp.net'
const BOT_LID = '99887766001@lid'
const NOW_S = Math.floor(Date.now() / 1000)
const NOW_MS = NOW_S * 1000

let dbs: ReturnType<typeof setupTestDbs>
let sent: { text: string; jobId: number }[]
let composing: string[]
let tenantId: number
let triggerId: number

beforeEach(() => {
  dbs = setupTestDbs()
  sent = []
  composing = []
  updateBotUser({ id: BOT_JID, lid: BOT_LID } as never)
  seedGroup('qa@g.us', 'Admins')
  seedGroup('a@g.us', 'Alpha')
  seedUser('asker@lid', 'Anna', '4917612345678')
  seedMember('a@g.us', 'asker@lid')
  seedMember('qa@g.us', 'asker@lid')
  tenantId = seedTenant('T', ['qa@g.us', 'a@g.us'])
  triggerId = seedQaTrigger(tenantId, 'qa@g.us')
  setSetting('gemini_api_key', 'sk-test')
})
afterEach(() => { dbs.cleanup() })

function makeJob(
  text = 'how many messages in September?',
  payloadExtra: Record<string, unknown> = {},
  jobTriggerId: number | null = triggerId,
): BotJob {
  const qId = seedMessage('qa@g.us', 'asker@lid', text, NOW_S - 5)
  const id = insertJob({
    jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: qId, triggerId: jobTriggerId,
    payload: { text, ...payloadExtra }, runAt: NOW_S, expiresAt: NOW_S + 600,
  })!
  return getJob(id)!
}

/** A final answer as the AI writes it: the JSON answer object. */
const answer = (output: string) => ({ text: JSON.stringify({ error: false, output }) })

function setTriggerConfig(config: Partial<QaTriggerConfig>, name?: string): void {
  updateTrigger(triggerId, { ...(name ? { name } : {}), config: { ...QA_TRIGGER_DEFAULTS, qaGroupJid: 'qa@g.us', ...config } })
}

function makeNotifier() {
  return buildTriggerErrorNotifier({ sendReply: async (job, text) => { sent.push({ text, jobId: job.id }); return `ERR${sent.length}` } })
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
      { ...answer('There were *0* messages.'), usage: { tokensIn: 200, tokensOut: 20 } },
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
      answer('done'),
    ])
    await makeHandler(provider)(makeJob())
    const assistantTurn = provider.calls[1].messages.find(m => m.role === 'assistant') as { raw?: unknown }
    expect(assistantTurn.raw).toBe(raw)
  })

  it('expands placeholders in tools and identifies the bot account in the system prompt', async () => {
    setSetting('timezone', 'Europe/Lisbon')
    const provider = fakeProvider([answer('ok')])
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
    const provider = fakeProvider([answer('ok')])
    await makeHandler(provider)(makeJob())
    // must follow the real limit, or the model plans for the wrong budget
    // the last round has tools off, so one fewer round can call them
    expect(provider.calls[0].system).toContain(`${QA_MAX_ROUNDS - 1} rounds`)
  })

  it('annotates every scope group with its data-since date', async () => {
    seedGroup('comm@g.us', 'Hive', { isCommunity: true })
    seedGroup('c@g.us', 'Child', { parentCommunityJid: 'comm@g.us' })
    setTenantGroups(tenantId, ['qa@g.us', 'a@g.us', 'comm@g.us'])
    seedMessage('a@g.us', 'asker@lid', 'old alpha message', NOW_S - 5 * 86400)
    const provider = fakeProvider([answer('ok')])
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
    const provider = fakeProvider([answer('Follow-up answer.')])
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
    const provider = fakeProvider([answer('ok')])
    await makeHandler(provider)(makeJob())
    const text = (provider.calls[0].messages[0] as { text: string }).text
    expect(text).toContain('fresh chatter')
    expect(text).not.toContain('ancient chatter')
  })

  it('replays ancestor answers as JSON turns', async () => {
    // a parent whose answer is in the activity log (the bot's echoed reply)
    const pq = seedMessage('qa@g.us', 'asker@lid', 'first question', NOW_S - 300)
    const p1 = insertJob({
      jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: pq,
      payload: { text: 'first question' }, runAt: NOW_S - 300, expiresAt: NOW_S + 600,
    })!
    const aid = seedMessage('qa@g.us', BOT_LID, 'The first answer', NOW_S - 290)
    addJobEvent(p1, 'reply_sent', { groupJid: 'qa@g.us', messageId: aid, data: { chars: 16 } })

    // its follow-up, whose reply is not in the log: read from the ai_call's JSON
    const q2 = seedMessage('qa@g.us', 'asker@lid', 'second question', NOW_S - 200)
    const p2 = insertJob({
      jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: q2,
      payload: { text: 'second question', parentJobId: p1 }, runAt: NOW_S - 200, expiresAt: NOW_S + 600,
    })!
    addJobEvent(p2, 'ai_call', { data: { response: { text: '```json\n{"error":false,"output":"The second answer"}\n```' } } })
    addJobEvent(p2, 'reply_sent', { groupJid: 'qa@g.us', messageId: 'NOT-LOGGED', data: { chars: 17 } })

    // a job from before JSON answers: its ai_call holds the plain answer
    const q3 = seedMessage('qa@g.us', 'asker@lid', 'third question', NOW_S - 100)
    const p3 = insertJob({
      jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: q3,
      payload: { text: 'third question', parentJobId: p2 }, runAt: NOW_S - 100, expiresAt: NOW_S + 600,
    })!
    addJobEvent(p3, 'ai_call', { data: { response: { text: 'The third answer' } } })
    addJobEvent(p3, 'reply_sent', { groupJid: 'qa@g.us', messageId: 'NOT-LOGGED-EITHER', data: { chars: 16 } })

    const provider = fakeProvider([answer('Fourth answer.')])
    await makeHandler(provider)(makeJob('and details?', { parentJobId: p3 }))
    const msgs = provider.calls[0].messages
    expect(msgs.slice(0, 6)).toEqual([
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: JSON.stringify({ error: false, output: 'The first answer' }) },
      { role: 'user', text: 'second question' },
      { role: 'assistant', text: JSON.stringify({ error: false, output: 'The second answer' }) },
      { role: 'user', text: 'third question' },
      { role: 'assistant', text: JSON.stringify({ error: false, output: 'The third answer' }) },
    ])
    expect(msgs.length).toBe(7)
    expect(msgs[6].role).toBe('user')
    expect((msgs[6] as { text: string }).text).toContain('and details?')
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
    const provider = fakeProvider([answer('done')])
    await makeHandler(provider)(makeJob('latest?', { parentJobId }))
    const msgs = provider.calls[0].messages
    expect(msgs.length).toBe(QA_THREAD_MAX_DEPTH * 2 + 1)
    // nearest ancestors kept: the oldest replayed turn is q3 of the 12-long chain
    expect((msgs[0] as { text: string }).text).toBe('q3')
  })

  it('replies with output from a valid JSON answer', async () => {
    const provider = fakeProvider([answer('  There were *3* messages.  ')])
    const job = makeJob()
    const result = await makeHandler(provider)(job)
    expect(sent).toEqual([{ text: 'There were *3* messages.', jobId: job.id }])
    expect(result).toMatchObject({ replyMessageId: 'SENT1', answerChars: 'There were *3* messages.'.length })
    const replied = getJobEvents(job.id).find(e => e.eventType === 'reply_sent')!
    expect(replied).toMatchObject({ messageId: 'SENT1', groupJid: 'qa@g.us', userJid: 'asker@lid' })
  })

  it('uses the trigger prompt when set and the default when empty; appends instructions, then the answer format last', async () => {
    setSetting('ai_system_prompt', 'THE OLD SETTINGS PROMPT') // no longer read
    const first = fakeProvider([answer('ok')])
    await makeHandler(first)(makeJob())
    const defaultSystem = first.calls[0].system
    expect(defaultSystem.startsWith(DEFAULT_QA_SYSTEM_PROMPT.split('\n')[0])).toBe(true)
    expect(defaultSystem).toContain('99887766001') // {{botlid}} in the default prompt expanded
    expect(defaultSystem).not.toContain('THE OLD SETTINGS PROMPT')
    expect(defaultSystem).not.toContain('Additional instructions')
    expect(defaultSystem.endsWith(QA_ANSWER_SPEC.formatSection)).toBe(true)

    setTriggerConfig({ prompt: 'You are a pirate in {{timezone}}.', instructions: 'Always answer in Russian.' })
    const second = fakeProvider([answer('Хорошо.')])
    await makeHandler(second)(makeJob('another question'))
    const sys = second.calls[0].system
    expect(sys.startsWith('You are a pirate in UTC.')).toBe(true)
    expect(sys).not.toContain(DEFAULT_QA_SYSTEM_PROMPT.split('\n')[0])
    expect(sys).toContain('Current date and time:')
    expect(sys).toContain('the group where this question was asked')
    expect(sys).toContain('Additional instructions from the group administrators:\nAlways answer in Russian.')
    expect(sys.indexOf('Groups you can report on:')).toBeLessThan(sys.indexOf('Additional instructions'))
    expect(sys.endsWith(QA_ANSWER_SPEC.formatSection)).toBe(true)

    setTriggerConfig({ prompt: '   ', instructions: '  ' }) // blank counts as empty
    const third = fakeProvider([answer('ok')])
    await makeHandler(third)(makeJob('third question'))
    expect(third.calls[0].system.startsWith(DEFAULT_QA_SYSTEM_PROMPT.split('\n')[0])).toBe(true)
    expect(third.calls[0].system).not.toContain('Additional instructions')
  })

  it('sends the answer schema on the final round', async () => {
    const provider = fakeProvider([
      ...Array.from({ length: QA_MAX_ROUNDS - 1 }, () => ({ toolCalls: [{ name: 'group_list', args: {} }] })),
      answer('ok'),
    ])
    await makeHandler(provider)(makeJob())
    expect(provider.calls.at(-1)!.responseSchema).toBe(QA_ANSWER_SPEC.modelSchema)
    // tool rounds carry it only when the model accepts both together
    expect(provider.calls[0].responseSchema).toBe(SEND_ANSWER_SCHEMA_WITH_TOOLS ? QA_ANSWER_SPEC.modelSchema : undefined)
  })

  it('goes to the final round when a tool round returns prose (Review Focus 4)', async () => {
    const provider = fakeProvider([
      { text: 'Sure! Alpha was quite active.' },
      answer('Alpha had 3 messages.'),
    ])
    const job = makeJob()
    await makeHandler(provider)(job)
    expect(provider.calls.length).toBe(2)
    expect(provider.calls[1].tools).toEqual([])
    expect(provider.calls[1].responseSchema).toBe(QA_ANSWER_SPEC.modelSchema)
    expect((provider.calls[1].messages.at(-1) as { text: string }).text).toContain('Answer now with the JSON object')
    expect(sent.map(m => m.text)).toEqual(['Alpha had 3 messages.'])
    const aiCalls = getJobEvents(job.id).filter(e => e.eventType === 'ai_call')
    expect(aiCalls.map(e => e.data!.toolsOff)).toEqual([undefined, 'invalid answer'])

    // a ```json fence around the answer is accepted as it is
    const fenced = fakeProvider([{ text: '```json\n{"error": false, "output": "Fenced answer."}\n```' }])
    await makeHandler(fenced)(makeJob('fenced question'))
    expect(fenced.calls.length).toBe(1)
    expect(sent.at(-1)!.text).toBe('Fenced answer.')
  })

  it('treats an empty response or a blank output like prose', async () => {
    const provider = fakeProvider([{}, answer('Now with an answer.')])
    await makeHandler(provider)(makeJob())
    expect(provider.calls[1].tools).toEqual([])
    expect(sent.map(m => m.text)).toEqual(['Now with an answer.'])

    const blank = fakeProvider([answer('   '), answer('   ')])
    await expect(makeHandler(blank)(makeJob('blank question'))).rejects.toMatchObject({ userText: ERROR_TEXT.invalidAnswer })
    expect(sent.length).toBe(1)
  })

  it('fails with the invalid-answer text when the final round is not valid JSON', async () => {
    const prose = fakeProvider([{ text: 'Some prose.' }, { text: 'Still prose, no JSON.' }])
    const job = makeJob()
    await expect(makeHandler(prose)(job)).rejects.toMatchObject({ userText: 'the AI did not return a valid answer' })
    expect(sent).toEqual([])
    expect(getJobEvents(job.id).some(e => e.eventType === 'reply_sent')).toBe(false)

    // the final round still asks for tools
    const toolsAgain = fakeProvider(Array.from({ length: QA_MAX_ROUNDS }, () => ({ toolCalls: [{ name: 'group_list', args: {} }] })))
    const job2 = makeJob('second question')
    const err = await makeHandler(toolsAgain)(job2).catch(e => e)
    expect(err).toBeInstanceOf(TriggerJobError)
    expect(err).toMatchObject({ userText: ERROR_TEXT.invalidAnswer, message: expect.stringMatching(/still asked for tools/) })
    expect(getJobEvents(job2.id).filter(e => e.eventType === 'tool_call').length).toBe(QA_MAX_ROUNDS - 1)

    // the final round comes back empty
    const empty = fakeProvider([...Array.from({ length: QA_MAX_ROUNDS - 1 }, () => ({ toolCalls: [{ name: 'group_list', args: {} }] })), {}])
    await expect(makeHandler(empty)(makeJob('third question'))).rejects.toMatchObject({ userText: ERROR_TEXT.invalidAnswer })

    // valid JSON in the wrong shape
    const shape = fakeProvider([{ text: '{"error": false}' }, { text: '{"answer": "x"}' }])
    await expect(makeHandler(shape)(makeJob('fourth question'))).rejects.toMatchObject({ userText: ERROR_TEXT.invalidAnswer })
    expect(sent).toEqual([])
  })

  it('fails with the AI\'s own message on error:true and sends nothing itself', async () => {
    const provider = fakeProvider([{ text: JSON.stringify({ error: true, errormessage: '  The tools keep failing.  ' }) }])
    const job = makeJob()
    const err = await makeHandler(provider)(job).catch(e => e)
    expect(err).toBeInstanceOf(TriggerJobError)
    expect(err.userText).toBe('The tools keep failing.')
    expect(provider.calls.length).toBe(1)
    expect(sent).toEqual([])
    expect(getJobEvents(job.id).some(e => e.eventType === 'reply_sent')).toBe(false)

    // no message, or a blank one: a generic text
    const bare = fakeProvider([{ text: '{"error": true}' }])
    await expect(makeHandler(bare)(makeJob('q2'))).rejects.toMatchObject({ userText: 'the AI could not answer' })
    const blank = fakeProvider([{ text: '{"error": true, "errormessage": "  "}' }])
    await expect(makeHandler(blank)(makeJob('q3'))).rejects.toMatchObject({ userText: 'the AI could not answer' })
    expect(sent).toEqual([])
  })

  it('fails without an AI call when the key is missing or no other group is in the tenant', async () => {
    const provider = fakeProvider([])
    setSetting('gemini_api_key', '')
    await expect(makeHandler(provider)(makeJob('q1'))).rejects.toMatchObject({ userText: 'the AI is not set up yet (API key missing)' })

    setSetting('gemini_api_key', 'sk-test')
    setTenantGroups(tenantId, ['qa@g.us'])
    await expect(makeHandler(provider)(makeJob('q2'))).rejects.toMatchObject({ userText: 'no other groups are in this tenant yet' })

    // a community with no reachable groups does not count
    seedGroup('empty-comm@g.us', 'Ghost Town', { isCommunity: true })
    setTenantGroups(tenantId, ['qa@g.us', 'empty-comm@g.us'])
    await expect(makeHandler(provider)(makeJob('q3'))).rejects.toMatchObject({ userText: 'no other groups are in this tenant yet' })

    expect(provider.calls.length).toBe(0)
    expect(sent).toEqual([])
    expect(composing).toEqual([])
  })

  it('reads the groups from the tenant, not from the old group settings', async () => {
    seedGroup('b@g.us', 'Beta')
    setTenantGroups(tenantId, ['qa@g.us', 'a@g.us', 'b@g.us'])
    const provider = fakeProvider([answer('ok')])
    await makeHandler(provider)(makeJob())
    expect(provider.calls[0].system).toContain('- "Beta" (b@g.us)')
  })

  it('fails quietly for a job whose trigger is gone or that predates triggers (Review Focus 1)', async () => {
    const provider = fakeProvider([])
    const handler = makeHandler(provider)
    const notifier = makeNotifier()

    const old = makeJob('from before the upgrade', {}, null)
    await expect(handler(old)).rejects.toBeInstanceOf(TriggerGoneError)
    await notifier(old, 'x', new TriggerGoneError())
    // even when another error reaches the notifier, a job without a trigger posts nothing
    await notifier(old, 'Error: boom', new Error('boom'))

    const orphan = makeJob('trigger deleted later')
    deleteTrigger(triggerId)
    await expect(handler(orphan)).rejects.toBeInstanceOf(TriggerGoneError)
    await notifier(orphan, 'Error: boom', new Error('boom'))

    expect(provider.calls.length).toBe(0)
    expect(sent).toEqual([])
    expect(getJobEvents(old.id)).toEqual([])
    expect(getJobEvents(orphan.id)).toEqual([])
  })

  it.each([
    ['the trigger is switched off', () => setTriggerEnabled(triggerId, false), 'The trigger was switched off'],
    ['its Q&A group was changed', () => setTriggerConfig({ qaGroupJid: 'a@g.us' }), "The trigger's Q&A group was changed"],
    ['the group left the tenant', () => setTenantGroups(tenantId, ['a@g.us']), "The group is no longer in this trigger's tenant"],
  ])('fails quietly for a queued job when %s', async (_name, change, message) => {
    const provider = fakeProvider([])
    const job = makeJob()
    change()
    await expect(makeHandler(provider)(job)).rejects.toThrow(new TriggerGoneError(message))
    await makeNotifier()(job, 'x', new TriggerGoneError(message))
    expect(provider.calls.length).toBe(0)
    expect(sent).toEqual([])
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

  it('fails with the daily-limit text and sends no notice', async () => {
    setSetting('ai_daily_limit', '3')
    const spent = makeJob('old question')
    addJobAiUsage(spent.id, { calls: 3, tokensIn: 1, tokensOut: 1 })
    const provider = fakeProvider([])
    const q1 = makeJob('q1')
    const q2 = makeJob('q2')
    await expect(makeHandler(provider)(q1)).rejects.toMatchObject({ userText: 'the daily AI usage limit (3 calls) is reached' })
    await expect(makeHandler(provider)(q2)).rejects.toMatchObject({ userText: 'the daily AI usage limit (3 calls) is reached' })
    expect(provider.calls.length).toBe(0)
    expect(sent).toEqual([])
    expect(composing).toEqual([])
    expect(getJobEvents(q1.id)).toEqual([])
  })

  it('stops mid-loop when the limit is crossed by its own calls', async () => {
    setSetting('ai_daily_limit', '1')
    const provider = fakeProvider([
      { toolCalls: [{ name: 'group_list', args: {} }] },
      answer('never reached'),
    ])
    await expect(makeHandler(provider)(makeJob())).rejects.toMatchObject({ userText: ERROR_TEXT.dailyLimit(1) })
    expect(provider.calls.length).toBe(1)
    expect(sent).toEqual([])
  })

  it('feeds tool errors back to the model and recovers', async () => {
    const provider = fakeProvider([
      { toolCalls: [{ name: 'group_messages', args: { from: '2026-09-30', to: '2026-09-01' } }] },
      answer('Recovered fine.'),
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
      answer('Here is what I found so far.'),
    ])
    await makeHandler(provider)(makeJob())
    expect(provider.calls.map(hasTools)).toEqual([...Array(QA_MAX_ROUNDS - 1).fill(true), false])
    expect(sent[0].text).toBe('Here is what I found so far.')
  })

  it('gives the last round the tool results as plain text, with no tool calls left in the conversation', async () => {
    const provider = fakeProvider([
      { toolCalls: [{ name: 'group_list', args: { limit: 5 } }] },
      ...Array.from({ length: QA_MAX_ROUNDS - 2 }, toolRound),
      answer('ok'),
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
    expect(final.text.endsWith('You cannot call tools any more. Answer now with the JSON object described in the answer format, '
      + 'using only the results above. If something is still missing, say briefly what in output.')).toBe(true)
  })

  it('uses a valid answer on the final round even when tool calls come with it', async () => {
    const provider = fakeProvider([
      ...Array.from({ length: QA_MAX_ROUNDS - 1 }, toolRound),
      { ...answer('Answer with a stray call.'), toolCalls: [{ name: 'group_list', args: {} }] },
    ])
    await makeHandler(provider)(makeJob())
    expect(sent.map(m => m.text)).toEqual(['Answer with a stray call.'])
  })

  it('logs on the job why tools were off', async () => {
    const provider = fakeProvider([...Array.from({ length: QA_MAX_ROUNDS - 1 }, toolRound), answer('ok')])
    const job = makeJob()
    await makeHandler(provider)(job)
    const aiCalls = getJobEvents(job.id).filter(e => e.eventType === 'ai_call')
    expect(aiCalls.map(e => e.data!.toolsOff)).toEqual([...Array(QA_MAX_ROUNDS - 1).fill(undefined), 'last round'])
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
    const provider = slowProvider([toolRound(), answer('Answer under time pressure.')], 50_000, clock)
    const job = makeJob()
    await makeHandler(provider, () => clock.t)(job)
    expect(provider.calls.map(hasTools)).toEqual([true, false])
    expect(sent[0].text).toBe('Answer under time pressure.')
    expect(getJobEvents(job.id).filter(e => e.eventType === 'ai_call').at(-1)!.data!.toolsOff).toBe('time almost up')
  })

  it('keeps tools on while there is plenty of time left', async () => {
    const clock = { t: NOW_MS }
    const provider = slowProvider([toolRound(), toolRound(), answer('done')], 10_000, clock)
    await makeHandler(provider, () => clock.t)(makeJob())
    expect(provider.calls.map(hasTools)).toEqual([true, true, true])
  })

  it('truncates over-long answers with a hint', async () => {
    const provider = fakeProvider([answer('y'.repeat(QA_ANSWER_MAX_CHARS + 500))])
    await makeHandler(provider)(makeJob())
    expect(sent[0].text.length).toBeLessThanOrEqual(QA_ANSWER_MAX_CHARS + 60)
    expect(sent[0].text).toMatch(/narrow it down/)
  })

  it('does not log oversized tool results into events, only their size', async () => {
    for (let i = 0; i < 30; i++) seedMessage('a@g.us', 'asker@lid', 'z'.repeat(200), NOW_S - 50 + i)
    const provider = fakeProvider([
      { toolCalls: [{ name: 'group_messages', args: { group_jids: ['a@g.us'], from: '2020-01-01', to: '2030-01-01' } }] },
      answer('Summarized.'),
    ])
    const job = makeJob()
    await makeHandler(provider)(job)
    const toolEvent = getJobEvents(job.id).find(e => e.eventType === 'tool_call')!
    expect(toolEvent.data!.resultChars as number).toBeGreaterThan(2000)
    expect('result' in toolEvent.data!).toBe(false)
  })
})

describe('trigger error notifier', () => {
  it('notifier posts the rendered template with the error text and records error_sent', async () => {
    const notify = makeNotifier()
    const limited = makeJob('limited q')
    const err = new TriggerJobError(ERROR_TEXT.dailyLimit(3))
    await notify(limited, err.stack!, err)
    expect(sent).toEqual([{ text: '⚠️ Sorry, I could not answer: the daily AI usage limit (3 calls) is reached', jobId: limited.id }])
    const events = getJobEvents(limited.id)
    expect(events.map(e => e.eventType)).toEqual(['error_sent']) // not a reply_sent
    expect(events[0]).toMatchObject({ groupJid: 'qa@g.us', messageId: 'ERR1' })

    // errors that are not ours: busy for a 429, generic otherwise, never internals
    await notify(makeJob('busy q'), 'Error: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', new Error('x'))
    expect(sent[1].text).toBe('⚠️ Sorry, I could not answer: the AI service is busy right now, please try again in a minute')
    await notify(makeJob('crash q'), 'TypeError: boom\n    at handleQaAnswer (/app/src/bot/responder.ts:429:12)', new TypeError('boom'))
    expect(sent[2].text).toBe('⚠️ Sorry, I could not answer: something went wrong; details are in the admin panel job log')
  })

  it('notifier uses the trigger\'s own template and placeholders', async () => {
    setTriggerConfig({ errorTemplate: '{{trigger}} in {{group}} for {{user}} about "{{message}}": {{error}}' }, 'Ask me')
    const question = 'q'.repeat(250)
    const job = makeJob(question)
    await makeNotifier()(job, 'x', new TriggerJobError('the AI could not answer'))
    expect(sent.map(s => s.text)).toEqual([`Ask me in Admins for @asker about "${'q'.repeat(200)}": the AI could not answer`])

    // a long AI message is cut before it goes into {{error}} (Review Focus 5)
    setTriggerConfig({ errorTemplate: '{{error}}' })
    await makeNotifier()(makeJob('long'), 'x', new TriggerJobError('e'.repeat(900)))
    expect(sent[1].text).toBe('e'.repeat(500))

    // a blank template means the default
    setTriggerConfig({ errorTemplate: '   ' })
    await makeNotifier()(makeJob('blank template'), 'x', new TriggerJobError('the AI could not answer'))
    expect(sent[2].text).toBe('⚠️ Sorry, I could not answer: the AI could not answer')
  })

  it('notifier stays silent once the answer was sent', async () => {
    const answered = makeJob('answered q')
    addJobEvent(answered.id, 'reply_sent', { messageId: 'X' })
    await makeNotifier()(answered, 'crashed after send', new Error('crashed after send'))
    expect(sent).toEqual([])
    expect(getJobEvents(answered.id).map(e => e.eventType)).toEqual(['reply_sent'])
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
