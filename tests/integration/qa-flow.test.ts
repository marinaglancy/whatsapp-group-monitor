import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { WAMessage } from 'baileys'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMember, seedMessage, seedTenant, seedQaTrigger } from '../helpers/fixtures.js'
import { fakeProvider } from '../helpers/fake-provider.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { setSetting } from '../../src/db/queries/settings.js'
import { ActivityRecord } from '../../src/whatsapp/activity/record.js'
import { clearJobHandlers, runWorkerPass, stopWorker } from '../../src/bot/worker.js'
import { setupBot } from '../../src/bot/setup.js'
import { listJobs, getJobEvents, insertJob, getJob, markJobProcessing } from '../../src/db/queries/jobs.js'
import type { BotJob } from '../../src/db/schema.js'

const BOT_JID = '15550001234@s.whatsapp.net'
const BOT_LID = '99887766001@lid'

let dbs: ReturnType<typeof setupTestDbs>
let sent: { job: BotJob; text: string }[]
let provider: ReturnType<typeof fakeProvider>

/** A final answer as the AI writes it: the JSON answer object. */
const answer = (output: string) => ({ text: JSON.stringify({ error: false, output }) })
const errorPost = (error: string) => `⚠️ Sorry, I could not answer: ${error}`

beforeEach(() => {
  dbs = setupTestDbs()
  sent = []
  clearJobHandlers()
  updateBotUser({ id: BOT_JID, lid: BOT_LID } as never)
  seedGroup('qa@g.us', 'Admins')
  seedGroup('a@g.us', 'Alpha')
  seedUser('u9@lid', 'Anna')
  seedMember('a@g.us', 'u9@lid')
  seedMessage('a@g.us', 'u9@lid', 'some linked-group chatter', Math.floor(Date.now() / 1000) - 3600)
  seedQaTrigger(seedTenant('T', ['qa@g.us', 'a@g.us']), 'qa@g.us')
  setSetting('gemini_api_key', 'sk-test')
  provider = fakeProvider([
    { toolCalls: [{ name: 'group_list', args: {} }] },
    answer('Alpha had *1* message.'),
    answer('The follow-up answer.'),
  ])
  let n = 0
  setupBot({
    createProvider: () => provider,
    sendReply: async (job, text) => { sent.push({ job, text }); return `REPLY${++n}` },
  })
})
afterEach(() => { stopWorker(); dbs.cleanup() })

function incoming(text: string, id: string, opts: { quoted?: string } = {}): WAMessage {
  return {
    key: { remoteJid: 'qa@g.us', id, participant: 'asker:1@s.whatsapp.net', fromMe: false },
    message: {
      extendedTextMessage: {
        text,
        contextInfo: {
          ...(opts.quoted ? { stanzaId: opts.quoted } : { mentionedJid: [BOT_JID] }),
        },
      },
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Asker',
  } as unknown as WAMessage
}

describe('qa flow end-to-end (AI responder)', () => {
  it('answers a mention from message ingestion to reply', async () => {
    ActivityRecord.fromMessage(incoming('@bot how active was Alpha?', 'INCOMING1'), 'qa@g.us')!.saveAndProcess()

    let { jobs } = listJobs({ limit: 10, offset: 0 })
    expect(jobs.length).toBe(1)
    expect(jobs[0].status).toBe('pending')
    expect(jobs[0].payload).toMatchObject({ text: '@bot how active was Alpha?' })

    await runWorkerPass()

    ;({ jobs } = listJobs({ limit: 10, offset: 0 }))
    expect(jobs[0].status).toBe('done')
    expect(jobs[0].aiCalls).toBe(2)
    expect(jobs[0].result).toMatchObject({ replyMessageId: 'REPLY1' })
    expect(sent[0].text).toBe('Alpha had *1* message.')
    expect(getJobEvents(jobs[0].id).map(e => e.eventType)).toEqual(['ai_call', 'tool_call', 'ai_call', 'reply_sent'])
  })

  // stands in for the Gemini SDK's ApiError: an Error with an HTTP status,
  // whose message is the JSON error body
  function failingProvider(status: number, apiStatus: string) {
    const failing = fakeProvider([])
    let calls = 0
    failing.generate = async () => {
      calls++
      throw Object.assign(new Error(`{"error":{"code":${status},"status":"${apiStatus}"}}`), { status })
    }
    return { failing, calls: () => calls }
  }

  it('gives up at once on an AI error that a retry cannot fix, and posts the error template', async () => {
    const { failing, calls } = failingProvider(400, 'INVALID_ARGUMENT')
    provider = failing
    ActivityRecord.fromMessage(incoming('@bot how active was Alpha?', 'INCOMING1'), 'qa@g.us')!.saveAndProcess()
    await runWorkerPass()
    const job = listJobs({ limit: 10, offset: 0 }).jobs[0]
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(1)
    expect(calls()).toBe(1)
    expect(sent.map(s => s.text)).toEqual([errorPost('something went wrong; details are in the admin panel job log')])
    expect(sent[0].job.id).toBe(job.id)
    expect(getJobEvents(job.id).at(-1)).toMatchObject({ eventType: 'error_sent', messageId: 'REPLY1' })
  })

  it('retries once when the AI service is busy, then posts the busy text', async () => {
    const { failing, calls } = failingProvider(503, 'UNAVAILABLE')
    provider = failing
    ActivityRecord.fromMessage(incoming('@bot how active was Alpha?', 'INCOMING1'), 'qa@g.us')!.saveAndProcess()
    await runWorkerPass()
    const job = listJobs({ limit: 10, offset: 0 }).jobs[0]
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(2)
    expect(calls()).toBe(2)
    expect(sent.map(s => s.text)).toEqual([errorPost('the AI service is busy right now, please try again in a minute')])
  })

  it('posts the invalid-answer error when the last round fails, without a retry', async () => {
    const { QA_MAX_ROUNDS } = await import('../../src/bot/responder.js')
    provider = fakeProvider(Array.from({ length: QA_MAX_ROUNDS }, () => ({ toolCalls: [{ name: 'group_list', args: {} }] })))
    ActivityRecord.fromMessage(incoming('@bot how active was Alpha?', 'INCOMING1'), 'qa@g.us')!.saveAndProcess()
    await runWorkerPass()
    const job = listJobs({ limit: 10, offset: 0 }).jobs[0]
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(1)
    expect(job.error).toMatch(/still asked for tools/)
    expect(sent.map(s => s.text)).toEqual([errorPost('the AI did not return a valid answer')])
  })

  it('posts the AI\'s own error message, without a retry even when it sounds transient', async () => {
    provider = fakeProvider([{ text: JSON.stringify({ error: true, errormessage: 'The tools timed out.' }) }])
    ActivityRecord.fromMessage(incoming('@bot how active was Alpha?', 'INCOMING1'), 'qa@g.us')!.saveAndProcess()
    await runWorkerPass()
    const job = listJobs({ limit: 10, offset: 0 }).jobs[0]
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(1)
    expect(sent.map(s => s.text)).toEqual([errorPost('The tools timed out.')])
  })

  it('posts the daily-limit error for every question over the limit', async () => {
    setSetting('ai_daily_limit', '2')
    ActivityRecord.fromMessage(incoming('@bot how active was Alpha?', 'INCOMING1'), 'qa@g.us')!.saveAndProcess()
    await runWorkerPass() // spends the 2 calls
    ActivityRecord.fromMessage(incoming('@bot and Beta?', 'INCOMING2'), 'qa@g.us')!.saveAndProcess()
    ActivityRecord.fromMessage(incoming('@bot and Gamma?', 'INCOMING3'), 'qa@g.us')!.saveAndProcess()
    await runWorkerPass()
    const limit = errorPost('the daily AI usage limit (2 calls) is reached')
    expect(sent.map(s => s.text)).toEqual(['Alpha had *1* message.', limit, limit])
    const failed = listJobs({ limit: 10, offset: 0 }).jobs.filter(j => j.status === 'failed')
    expect(failed.map(j => j.attempts)).toEqual([1, 1])
  })

  it('fails jobs from before the upgrade quietly, without a retry (Review Focus 1)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const qId = seedMessage('qa@g.us', 'asker@s.whatsapp.net', '@bot old question', now - 5)
    const pending = insertJob({
      jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@s.whatsapp.net', messageId: qId,
      payload: { text: '@bot old question' }, runAt: now, expiresAt: now + 600,
    })!
    const qId2 = seedMessage('qa@g.us', 'asker@s.whatsapp.net', '@bot another old question', now - 4)
    const processing = insertJob({
      jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@s.whatsapp.net', messageId: qId2,
      payload: { text: '@bot another old question' }, runAt: now, expiresAt: now + 600,
    })!
    markJobProcessing(processing) // left mid-flight by the old version
    await runWorkerPass()
    await runWorkerPass() // nothing left to run: no crash loop
    expect(getJob(pending)).toMatchObject({ status: 'failed', attempts: 1 })
    expect(getJob(processing)).toMatchObject({ status: 'failed', attempts: 2 })
    expect(provider.calls.length).toBe(0)
    expect(sent).toEqual([])
  })

  it('threads a follow-up reply through the ancestor exchange', async () => {
    ActivityRecord.fromMessage(incoming('@bot how active was Alpha?', 'INCOMING1'), 'qa@g.us')!.saveAndProcess()
    await runWorkerPass()
    const firstJob = listJobs({ limit: 10, offset: 0 }).jobs[0]

    // the bot's reply echoes back through the normal fromMe pipeline
    seedMessage('qa@g.us', BOT_LID, 'Alpha had *1* message.', Math.floor(Date.now() / 1000) - 2, { messageId: 'REPLY1' })

    ActivityRecord.fromMessage(incoming('and yesterday?', 'INCOMING2', { quoted: 'REPLY1' }), 'qa@g.us')!.saveAndProcess()
    await runWorkerPass()

    const { jobs } = listJobs({ limit: 10, offset: 0 })
    const followUp = jobs.find(j => j.id !== firstJob.id)!
    expect(followUp.status).toBe('done')
    expect(followUp.payload).toMatchObject({ quotedBotMessageId: 'REPLY1', parentJobId: firstJob.id })
    expect(sent[1].text).toBe('The follow-up answer.')

    // the follow-up's provider call replayed the first exchange as turns
    const lastCall = provider.calls.at(-1)!
    expect(lastCall.messages[0]).toEqual({ role: 'user', text: '@bot how active was Alpha?' })
    expect(lastCall.messages[1]).toEqual({ role: 'assistant', text: JSON.stringify({ error: false, output: 'Alpha had *1* message.' }) })
  })

  it('is idempotent when the same message is replayed', async () => {
    ActivityRecord.fromMessage(incoming('@bot how active was Alpha?', 'INCOMING1'), 'qa@g.us')!.saveAndProcess()
    await runWorkerPass()
    ActivityRecord.fromMessage(incoming('@bot how active was Alpha?', 'INCOMING1'), 'qa@g.us')!.saveAndProcess() // replay: duplicate insert ignored
    await runWorkerPass()
    expect(listJobs({ limit: 10, offset: 0 }).total).toBe(1)
    expect(sent.length).toBe(1)
  })

  it('does not double-send when a previous attempt already replied', async () => {
    ActivityRecord.fromMessage(incoming('@bot how active was Alpha?', 'INCOMING1'), 'qa@g.us')!.saveAndProcess()
    const { jobs } = listJobs({ limit: 10, offset: 0 })
    // simulate: previous attempt sent the reply, then crashed before completion
    const { addJobEvent, requeueJob } = await import('../../src/db/queries/jobs.js')
    addJobEvent(jobs[0].id, 'reply_sent', { messageId: 'OLD' })
    requeueJob(jobs[0].id, 'crash before completion')
    await runWorkerPass()
    expect(sent.length).toBe(0)
    expect(listJobs({ limit: 10, offset: 0 }).jobs[0].status).toBe('done')
  })
})
