import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { WAMessage } from 'baileys'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedTenant, seedSpamTrigger } from '../helpers/fixtures.js'
import { fakeProvider } from '../helpers/fake-provider.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { setSetting } from '../../src/db/queries/settings.js'
import { ActivityRecord } from '../../src/whatsapp/activity/record.js'
import { clearJobHandlers, runWorkerPass, stopWorker } from '../../src/bot/worker.js'
import { setupBot } from '../../src/bot/setup.js'
import { listJobs, getJobEvents } from '../../src/db/queries/jobs.js'
import { resetErrorThrottleForTests } from '../../src/triggers/error-notifier.js'

const BOT_JID = '15550001234@s.whatsapp.net'
const BOT_LID = '99887766001@lid'
const TEXT = 'Easy money! Join https://chat.whatsapp.com/AbC123'

let dbs: ReturnType<typeof setupTestDbs>
let posts: { groupJid: string; text: string }[]
let edits: { groupJid: string; messageId: string; text: string }[]
let provider: ReturnType<typeof fakeProvider>

const verdict = (isspam: boolean, isspammer: boolean) =>
  ({ text: JSON.stringify({ error: false, isspam, isspammer, reason: 'Money scam link.' }) })

beforeEach(() => {
  dbs = setupTestDbs()
  posts = []
  edits = []
  clearJobHandlers()
  resetErrorThrottleForTests()
  updateBotUser({ id: BOT_JID, lid: BOT_LID } as never)
  seedGroup('111@g.us', 'Alpha')
  seedGroup('222@g.us', 'Beta')
  seedGroup('999@g.us', 'Reports')
  const tenantId = seedTenant('T', ['111@g.us', '222@g.us', '999@g.us'])
  seedSpamTrigger(tenantId, '999@g.us', { config: { waitSeconds: 0 } })
  setSetting('gemini_api_key', 'sk-test')
  provider = fakeProvider([verdict(true, true)])
  let n = 0
  setupBot({
    createProvider: () => provider,
    post: async (groupJid, text) => { posts.push({ groupJid, text }); return `REP${++n}` },
    edit: async (groupJid, messageId, text) => { edits.push({ groupJid, messageId, text }) },
  })
})
afterEach(() => { stopWorker(); dbs.cleanup() })

function incoming(groupJid: string, id: string, text = TEXT): WAMessage {
  return {
    key: { remoteJid: groupJid, id, participant: '555123@lid', fromMe: false },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Spammer',
  } as unknown as WAMessage
}

function receive(groupJid: string, id: string, text = TEXT): void {
  ActivityRecord.fromMessage(incoming(groupJid, id, text), groupJid)!.saveAndProcess()
}

describe('spam flow end-to-end', () => {
  it('reports a spam message from ingestion to the notification group', async () => {
    receive('111@g.us', 'IN1')
    let { jobs } = listJobs({ limit: 10, offset: 0 })
    expect(jobs.map(j => [j.jobType, j.status])).toEqual([['spam_check', 'pending']])

    await runWorkerPass()

    ;({ jobs } = listJobs({ limit: 10, offset: 0 }))
    expect(jobs[0].status).toBe('done')
    expect(jobs[0].aiCalls).toBe(1)
    expect(jobs[0].result).toMatchObject({ verdict: { isspam: true, isspammer: true }, report: 'posted', reportMessageId: 'REP1' })
    expect(posts).toEqual([{
      groupJid: '999@g.us',
      text: `Detected spam by user @555123:\n\n*Not deleted!*\n- group @111\n\n*Deleted message contents:*\n${TEXT}`,
    }])
    expect(getJobEvents(jobs[0].id).map(e => e.eventType)).toEqual(['ai_call', 'report_posted'])
  })

  it('handles a wave in two groups with one AI call and one report', async () => {
    receive('111@g.us', 'IN1')
    receive('222@g.us', 'IN2', `  ${TEXT} `)
    await runWorkerPass()

    const { jobs } = listJobs({ limit: 10, offset: 0 })
    expect(jobs.map(j => j.status)).toEqual(['done', 'done'])
    expect(provider.calls.length).toBe(1)
    expect(posts.length).toBe(1)
    expect(posts[0].text).toContain('- group @111\n- group @222')
    expect(edits).toEqual([])
  })

  it('posts one error in the notification group for two failing jobs within 10 minutes', async () => {
    setSetting('gemini_api_key', '')
    receive('111@g.us', 'IN1')
    receive('222@g.us', 'IN2', 'Another offer https://x.y/z')
    await runWorkerPass()

    const { jobs } = listJobs({ limit: 10, offset: 0 })
    expect(jobs.map(j => [j.status, j.attempts])).toEqual([['failed', 1], ['failed', 1]])
    expect(posts).toEqual([{
      groupJid: '999@g.us',
      text: '⚠️ Spam check failed for a message by @555123 in Alpha: the AI is not set up yet (API key missing)',
    }])
  })
})
