import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { WAMessage } from 'baileys'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMember, seedMessage, seedTenant, seedQaTrigger } from '../helpers/fixtures.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { ActivityRecord } from '../../src/whatsapp/activity/record.js'
import { clearJobHandlers, runWorkerPass, stopWorker } from '../../src/bot/worker.js'
import { setupBot } from '../../src/bot/setup.js'
import { insertJob, getJob, listJobs } from '../../src/db/queries/jobs.js'
import type { BotJob } from '../../src/db/schema.js'

const BOT_JID = '15550001234@s.whatsapp.net'

let dbs: ReturnType<typeof setupTestDbs>
let sent: { job: BotJob; text: string }[]
let seq = 0

beforeEach(() => {
  dbs = setupTestDbs()
  sent = []
  clearJobHandlers()
  updateBotUser({ id: BOT_JID } as never)
  seedGroup('qa@g.us', 'Admins')
  seedGroup('a@g.us', 'Alpha')
  seedUser('u1@lid', 'Anna')
  seedMember('a@g.us', 'u1@lid')
  seedMessage('a@g.us', 'u1@lid', 'some alpha message', Math.floor(Date.now() / 1000) - 600)
  seedQaTrigger(seedTenant('T', ['qa@g.us', 'a@g.us']), 'qa@g.us')
  setupBot({ sendReply: async (job, text) => { sent.push({ job, text }); return 'R1' } })
})
afterEach(() => { stopWorker(); dbs.cleanup() })

/** A message that mentions the bot arrives in the Q&A group. */
function ask(text: string): void {
  const msg = {
    key: { remoteJid: 'qa@g.us', id: `E${++seq}`, participant: 'asker:1@s.whatsapp.net', fromMe: false },
    message: { extendedTextMessage: { text, contextInfo: { mentionedJid: [BOT_JID] } } },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Asker',
  } as unknown as WAMessage
  ActivityRecord.fromMessage(msg, 'qa@g.us')!.saveAndProcess()
}

describe('tool-echo mode (debug commands, no AI cost)', () => {
  it('lists tools on !tools', async () => {
    ask('!tools')
    await runWorkerPass()
    expect(sent[0].text).toContain('group_list')
    expect(sent[0].text).toContain('message_search')
  })

  it('executes a tool over the tenant\'s groups and echoes the pretty result, even with a leading mention token', async () => {
    ask('@15550001234 !tool group_list {"fields": ["member_count"]}')
    await runWorkerPass()
    expect(sent[0].text).toContain('"Alpha"')
    expect(sent[0].text).toContain('"member_count": 1')
    const { jobs } = listJobs({ limit: 1, offset: 0 })
    expect(jobs[0].status).toBe('done')
    expect(jobs[0].result).toMatchObject({ stub: true, tool: 'group_list' })
  })

  it('echoes tool errors and survives bad JSON args', async () => {
    ask('!tool group_list {"group_jids": ["nope@g.us"]}')
    ask('!tool group_list {broken json')
    await runWorkerPass()
    expect(sent[0].text).toContain('not in scope')
    expect(sent[1].text.toLowerCase()).toContain('json')
  })

  it('routes normal questions to the AI responder', async () => {
    // no API key configured: the responder fails and the error template is
    // posted, proving non-command questions no longer hit the echo branch
    ask('how active was Alpha?')
    await runWorkerPass()
    expect(sent.map(s => s.text)).toEqual(['⚠️ Sorry, I could not answer: the AI is not set up yet (API key missing)'])
  })

  it('posts nothing for a command job from before the upgrade', async () => {
    const now = Math.floor(Date.now() / 1000)
    const id = insertJob({
      jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: 'OLD',
      payload: { text: '!tools' }, runAt: now, expiresAt: now + 600,
    })!
    await runWorkerPass()
    expect(getJob(id)).toMatchObject({ status: 'failed', attempts: 1 })
    expect(sent).toEqual([])
  })
})
