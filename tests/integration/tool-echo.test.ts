import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMember, seedMessage } from '../helpers/fixtures.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { updateGroupQaConfig } from '../../src/db/queries/groups.js'
import { clearJobHandlers, runWorkerPass, stopWorker } from '../../src/bot/worker.js'
import { setupBot } from '../../src/bot/setup.js'
import { insertJob, listJobs } from '../../src/db/queries/jobs.js'
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
  seedUser('u1@lid', 'Anna')
  seedMember('a@g.us', 'u1@lid')
  seedMessage('a@g.us', 'u1@lid', 'some alpha message', Math.floor(Date.now() / 1000) - 600)
  updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['a@g.us'] })
  setupBot({ sendReply: async (job, text) => { sent.push({ job, text }); return 'R1' } })
})
afterEach(() => { stopWorker(); dbs.cleanup() })

function enqueue(text: string) {
  return insertJob({
    jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: `E${Math.random()}`,
    payload: { text }, runAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 600,
  })!
}

describe('tool-echo mode (temporary, phase 3)', () => {
  it('lists tools on !tools', async () => {
    enqueue('!tools')
    await runWorkerPass()
    expect(sent[0].text).toContain('group_list')
    expect(sent[0].text).toContain('message_search')
  })

  it('executes a tool and echoes the pretty result, even with a leading mention token', async () => {
    enqueue('@15550001234 !tool group_list {"fields": ["member_count"]}')
    await runWorkerPass()
    expect(sent[0].text).toContain('"Alpha"')
    expect(sent[0].text).toContain('"member_count": 1')
    const { jobs } = listJobs({ limit: 1, offset: 0 })
    expect(jobs[0].status).toBe('done')
    expect(jobs[0].result).toMatchObject({ stub: true, tool: 'group_list' })
  })

  it('echoes tool errors and survives bad JSON args', async () => {
    enqueue('!tool group_list {"group_jids": ["nope@g.us"]}')
    enqueue('!tool group_list {broken json')
    await runWorkerPass()
    expect(sent[0].text).toContain('not in scope')
    expect(sent[1].text.toLowerCase()).toContain('json')
  })

  it('still acknowledges normal questions with the stub reply', async () => {
    enqueue('how active was Alpha?')
    await runWorkerPass()
    expect(sent[0].text).toContain('I heard')
  })
})
