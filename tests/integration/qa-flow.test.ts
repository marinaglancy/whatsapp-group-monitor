import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { WAMessage } from 'baileys'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMember, seedMessage } from '../helpers/fixtures.js'
import { fakeProvider } from '../helpers/fake-provider.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { updateGroupQaConfig } from '../../src/db/queries/groups.js'
import { setSetting } from '../../src/db/queries/settings.js'
import { ActivityRecord } from '../../src/whatsapp/activity/record.js'
import { clearJobHandlers, runWorkerPass, stopWorker } from '../../src/bot/worker.js'
import { setupBot } from '../../src/bot/setup.js'
import { listJobs, getJobEvents } from '../../src/db/queries/jobs.js'
import type { BotJob } from '../../src/db/schema.js'

const BOT_JID = '15550001234@s.whatsapp.net'
const BOT_LID = '99887766001@lid'

let dbs: ReturnType<typeof setupTestDbs>
let sent: { job: BotJob; text: string }[]
let provider: ReturnType<typeof fakeProvider>

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
  updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['a@g.us'] })
  setSetting('gemini_api_key', 'sk-test')
  provider = fakeProvider([
    { toolCalls: [{ name: 'group_list', args: {} }] },
    { text: 'Alpha had *1* message.' },
    { text: 'The follow-up answer.' },
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
    expect(lastCall.messages[1]).toEqual({ role: 'assistant', text: 'Alpha had *1* message.' })
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
