import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { WAMessage } from 'baileys'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMember } from '../helpers/fixtures.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { updateGroupQaConfig } from '../../src/db/queries/groups.js'
import { ActivityRecord } from '../../src/whatsapp/activity/record.js'
import { clearJobHandlers, runWorkerPass, stopWorker } from '../../src/bot/worker.js'
import { setupBot } from '../../src/bot/setup.js'
import { listJobs, getJobEvents } from '../../src/db/queries/jobs.js'
import type { BotJob } from '../../src/db/schema.js'

const BOT_JID = '15550001234@s.whatsapp.net'

let dbs: ReturnType<typeof setupTestDbs>
let sent: { job: BotJob; text: string }[]

beforeEach(() => {
  dbs = setupTestDbs()
  sent = []
  clearJobHandlers()
  updateBotUser({ id: BOT_JID } as never)
  seedGroup('qa@g.us', 'Admins')
  seedGroup('a@g.us', 'Alpha')
  seedUser('u9@lid', 'Anna')
  seedMember('a@g.us', 'u9@lid')
  updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['a@g.us'] })
  setupBot({ sendReply: async (job, text) => { sent.push({ job, text }); return 'REPLY1' } })
})
afterEach(() => { stopWorker(); dbs.cleanup() })

function incomingQuestion(): WAMessage {
  return {
    key: { remoteJid: 'qa@g.us', id: 'INCOMING1', participant: 'asker:1@s.whatsapp.net', fromMe: false },
    message: {
      extendedTextMessage: {
        text: '@bot how active was Alpha?',
        contextInfo: { mentionedJid: [BOT_JID] },
      },
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Asker',
  } as unknown as WAMessage
}

describe('qa flow end-to-end (phase 2: stub reply)', () => {
  it('acknowledges a mention from message ingestion to reply', async () => {
    const record = ActivityRecord.fromMessage(incomingQuestion(), 'qa@g.us')!
    record.saveAndProcess()

    let { jobs } = listJobs({ limit: 10, offset: 0 })
    expect(jobs.length).toBe(1)
    expect(jobs[0].status).toBe('pending')
    expect(jobs[0].payload).toMatchObject({ text: '@bot how active was Alpha?' })

    await runWorkerPass()

    ;({ jobs } = listJobs({ limit: 10, offset: 0 }))
    expect(jobs[0].status).toBe('done')
    expect(jobs[0].result).toMatchObject({ replyMessageId: 'REPLY1', stub: true })
    expect(sent.length).toBe(1)
    expect(sent[0].text).toContain(`Job #${jobs[0].id}`)
    const events = getJobEvents(jobs[0].id)
    expect(events.map(e => e.eventType)).toEqual(['reply_sent'])
    expect(events[0].messageId).toBe('REPLY1')
  })

  it('is idempotent when the same message is replayed', async () => {
    ActivityRecord.fromMessage(incomingQuestion(), 'qa@g.us')!.saveAndProcess()
    await runWorkerPass()
    ActivityRecord.fromMessage(incomingQuestion(), 'qa@g.us')!.saveAndProcess() // replay: duplicate insert ignored
    await runWorkerPass()
    expect(listJobs({ limit: 10, offset: 0 }).total).toBe(1)
    expect(sent.length).toBe(1)
  })

  it('does not double-send when a previous attempt already replied (Review Focus 2)', async () => {
    ActivityRecord.fromMessage(incomingQuestion(), 'qa@g.us')!.saveAndProcess()
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
