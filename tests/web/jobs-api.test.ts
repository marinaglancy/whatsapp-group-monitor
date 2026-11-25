import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { setupTestDbs } from '../helpers/db.js'
import { buildTestApp, loginTestApp } from '../helpers/web.js'
import { seedGroup, seedUser } from '../helpers/fixtures.js'
import { seedTenant, seedQaTrigger } from '../helpers/fixtures.js'
import { deleteTrigger } from '../../src/db/queries/triggers.js'
import { insertJob, failJob, addJobEvent, addJobAiUsage } from '../../src/db/queries/jobs.js'

let dbs: ReturnType<typeof setupTestDbs>
let app: FastifyInstance
let auth: { cookie: string; csrf: string }

beforeEach(async () => {
  dbs = setupTestDbs()
  seedGroup('qa@g.us', 'Admins')
  seedUser('asker@lid', 'Anna')
  app = await buildTestApp()
  auth = await loginTestApp(app)
})
afterEach(async () => { await app.close(); dbs.cleanup() })

const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: auth.cookie } })

describe('/api/jobs', () => {
  it('requires auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(401)
  })

  it('lists jobs newest-first with names and token totals', async () => {
    const j1 = insertJob({ jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: 'M1', runAt: 1 })!
    addJobAiUsage(j1, { calls: 2, tokensIn: 100, tokensOut: 30 })
    const j2 = insertJob({ jobType: 'qa_answer', groupJid: 'qa@g.us', messageId: 'M2', runAt: 1 })!
    const body = (await get('/api/jobs')).json()
    expect(body.total).toBe(2)
    expect(body.jobs[0].id).toBe(j2)
    // filter dropdown source: only groups that actually have jobs
    expect(body.groups).toEqual([{ jid: 'qa@g.us', name: 'Admins' }])
    expect(body.jobs[1].tokensTotal).toBe(130)
    expect(body.jobs[1].groupName).toBe('Admins')
    expect(body.jobs[1].userName).toBe('Anna') // spec §7: display name in the list
  })

  it('filters by status/type/group and ignores unknown filter values', async () => {
    for (let i = 0; i < 3; i++) insertJob({ jobType: 'qa_answer', groupJid: 'qa@g.us', messageId: `A${i}`, runAt: 1 })
    const f = insertJob({ jobType: 'spam_check', groupJid: 'other@g.us', messageId: 'S', runAt: 1 })!
    failJob(f, 'x')
    expect((await get('/api/jobs?status=failed')).json().total).toBe(1)
    expect((await get('/api/jobs?type=spam_check')).json().total).toBe(1)
    expect((await get('/api/jobs?group=qa%40g.us')).json().total).toBe(3)
    expect((await get('/api/jobs?status=nonsense')).json().total).toBe(4)
  })

  it('returns job detail with ordered events and names', async () => {
    const id = insertJob({ jobType: 'qa_answer', groupJid: 'qa@g.us', userJid: 'asker@lid', messageId: 'M9', payload: { text: 'q' }, runAt: 1 })!
    addJobEvent(id, 'ai_call', { data: { round: 1 } })
    addJobEvent(id, 'reply_sent', { messageId: 'R1' })
    const body = (await get(`/api/jobs/${id}`)).json()
    expect(body.job.payload).toEqual({ text: 'q' })
    expect(body.events.map((e: { eventType: string }) => e.eventType)).toEqual(['ai_call', 'reply_sent'])
    expect(body.groupName).toBe('Admins')
    expect(body.userName).toBe('Anna')
  })

  it('shows the trigger and tenant names on jobs: live, deleted and none', async () => {
    const tenant = seedTenant('Alpha', ['qa@g.us'])
    const live = seedQaTrigger(tenant, 'qa@g.us', { name: 'Questions' })
    const gone = seedQaTrigger(tenant, 'qa@g.us', { name: 'Old' })
    const jLive = insertJob({ jobType: 'qa_answer', triggerId: live, groupJid: 'qa@g.us', messageId: 'L', runAt: 1 })!
    const jGone = insertJob({ jobType: 'qa_answer', triggerId: gone, groupJid: 'qa@g.us', messageId: 'G', runAt: 1 })!
    const jNone = insertJob({ jobType: 'spam_check', groupJid: 'qa@g.us', messageId: 'N', runAt: 1 })!
    deleteTrigger(gone)
    const list = (await get('/api/jobs')).json().jobs as Array<{ id: number; triggerName: string | null; tenantName: string | null }>
    const by = (id: number) => list.find(j => j.id === id)!
    expect(by(jLive)).toMatchObject({ triggerName: 'Questions', tenantName: 'Alpha' })
    expect(by(jGone)).toMatchObject({ triggerName: 'deleted trigger', tenantName: null })
    expect(by(jNone)).toMatchObject({ triggerName: null, tenantName: null })
    const detail = (await get(`/api/jobs/${jLive}`)).json()
    expect(detail).toMatchObject({ triggerName: 'Questions', tenantName: 'Alpha' })
    expect((await get(`/api/jobs/${jGone}`)).json()).toMatchObject({ triggerName: 'deleted trigger', tenantName: null })
    expect((await get(`/api/jobs/${jNone}`)).json()).toMatchObject({ triggerName: null, tenantName: null })
  })

  it('404s on unknown and 400s on non-numeric ids', async () => {
    expect((await get('/api/jobs/99999')).statusCode).toBe(404)
    expect((await get('/api/jobs/abc')).statusCode).toBe(400)
  })
})
