import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedTenant, seedQaTrigger } from '../helpers/fixtures.js'
import { buildTestApp, loginTestApp } from '../helpers/web.js'
import { registerBuiltinTriggerTypes } from '../../src/triggers/index.js'
import { clearTriggerTypesForTests } from '../../src/triggers/registry.js'
import { listTriggers, getTrigger } from '../../src/db/queries/triggers.js'
import { getAccountDb } from '../../src/db/account.js'
import { tenantGroups } from '../../src/db/schema.js'
import { getTenant } from '../../src/db/queries/tenants.js'
import { DEFAULT_QA_SYSTEM_PROMPT, QA_DEFAULT_ERROR_TEMPLATE } from '../../src/triggers/qa/defaults.js'

let dbs: ReturnType<typeof setupTestDbs>
let app: FastifyInstance
let auth: { cookie: string; csrf: string }

beforeEach(async () => {
  dbs = setupTestDbs()
  clearTriggerTypesForTests()
  registerBuiltinTriggerTypes()
  app = await buildTestApp()
  auth = await loginTestApp(app)
})
afterEach(async () => { await app.close(); dbs.cleanup() })

function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, csrf = true) {
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: auth.cookie, ...(csrf ? { 'x-csrf-token': auth.csrf } : {}) },
  })
}

describe('tenants api', () => {
  it('requires auth and CSRF, and 503 when the account is not ready', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/tenants' })).statusCode).toBe(401)
    expect((await call('POST', '/api/tenants', { name: 'X' }, false)).statusCode).toBe(403)
    expect((await call('PUT', '/api/tenants/1', { name: 'X' }, false)).statusCode).toBe(403)
    expect((await call('DELETE', '/api/triggers/1', undefined, false)).statusCode).toBe(403)
    dbs.cleanup()
    expect((await call('GET', '/api/tenants')).statusCode).toBe(503)
    dbs = setupTestDbs()
  })

  it('lists tenants with entries and triggers', async () => {
    seedGroup('c@g.us', 'Comm', { isCommunity: true })
    seedGroup('k1@g.us', 'Kid1', { parentCommunityJid: 'c@g.us' })
    seedGroup('k2@g.us', 'Kid2', { parentCommunityJid: 'c@g.us' })
    const t = seedTenant('Alpha', ['c@g.us'])
    const trig = seedQaTrigger(t, 'k1@g.us', { name: 'Qs' })
    const res = await call('GET', '/api/tenants')
    expect(res.statusCode).toBe(200)
    expect(res.json().tenants).toEqual([{
      id: t, name: 'Alpha',
      entries: [{ jid: 'c@g.us', name: 'Comm', isCommunity: true, groupCount: 2 }],
      triggers: [{ id: trig, name: 'Qs', type: 'qa' }],
    }])
  })

  it('creates, renames and deletes a tenant (with its triggers)', async () => {
    seedGroup('g@g.us', 'G')
    const created = await call('POST', '/api/tenants', { name: '  New  ' })
    expect(created.statusCode).toBe(200)
    const id = created.json().id as number
    expect(getTenant(id)!.name).toBe('New')
    expect((await call('POST', '/api/tenants', { name: '   ' })).statusCode).toBe(400)
    expect((await call('POST', '/api/tenants', { name: 'x'.repeat(101) })).statusCode).toBe(400)

    expect((await call('PUT', `/api/tenants/${id}`, { name: 'Renamed' })).json()).toEqual({ ok: true })
    expect(getTenant(id)!.name).toBe('Renamed')
    expect((await call('PUT', '/api/tenants/9999', { name: 'Z' })).statusCode).toBe(404)

    await call('PUT', `/api/tenants/${id}/groups`, { jids: ['g@g.us'] })
    seedQaTrigger(id, 'g@g.us')
    expect((await call('DELETE', `/api/tenants/${id}`)).json()).toEqual({ ok: true })
    expect(getTenant(id)).toBeNull()
    expect(listTriggers(id)).toEqual([])
    expect((await call('DELETE', `/api/tenants/${id}`)).statusCode).toBe(404)
  })

  it('deletes a trigger and a tenant sent like the page sends them: no body, no content type, only the CSRF header', async () => {
    seedGroup('a@g.us', 'A')
    const t = seedTenant('One', ['a@g.us'])
    const trig = seedQaTrigger(t, 'a@g.us')
    const pageDelete = (url: string) => app.inject({ method: 'DELETE', url, headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf } })
    const delTrigger = await pageDelete(`/api/triggers/${trig}`)
    expect(delTrigger.statusCode).toBe(200)
    expect(getTrigger(trig)).toBeNull()
    const delTenant = await pageDelete(`/api/tenants/${t}`)
    expect(delTenant.statusCode).toBe(200)
    expect(getTenant(t)).toBeNull()
  })

  it('returns tenant detail with covered groups, warnings, triggers and types', async () => {
    seedGroup('c@g.us', 'Comm', { isCommunity: true })
    seedGroup('k1@g.us', 'Kid1', { parentCommunityJid: 'c@g.us' })
    seedGroup('k2@g.us', 'Kid2', { parentCommunityJid: 'c@g.us' })
    const t = seedTenant('Alpha', ['c@g.us'])
    // setTenantGroups refuses this overlap, so insert the row directly (it can arise when a group moves into a community)
    const beta = seedTenant('Beta', [])
    getAccountDb().insert(tenantGroups).values({ jid: 'k2@g.us', tenantId: beta }).run()
    const trig = seedQaTrigger(t, 'k2@g.us', { config: { waitSeconds: 5 } })
    const res = await call('GET', `/api/tenants/${t}`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tenant).toMatchObject({ id: t, name: 'Alpha' })
    expect(body.entries).toEqual([{ jid: 'c@g.us', name: 'Comm', isCommunity: true, groupCount: 2 }])
    expect(body.coveredGroups).toEqual([{ jid: 'k1@g.us', name: 'Kid1' }])
    expect(body.warnings).toEqual(['Kid2 is in tenant Beta directly, so it is not part of this tenant'])
    expect(body.triggers).toEqual([{
      id: trig, name: 'Questions', type: 'qa', typeName: 'Questions', enabled: true,
      summary: 'Q&A group: Kid2 · wait 5 s', warning: 'The Q&A group is not in this tenant',
    }])
    expect(body.triggerTypes).toEqual([{ id: 'qa', displayName: 'Questions' }])
    expect((await call('GET', '/api/tenants/9999')).statusCode).toBe(404)
  })

  it('sets groups, with 409 on conflict and 400 on unknown jids', async () => {
    seedGroup('a@g.us', 'A')
    seedGroup('b@g.us', 'B')
    const t1 = seedTenant('One', ['a@g.us'])
    const t2 = seedTenant('Two', [])
    const res = await call('PUT', `/api/tenants/${t2}/groups`, { jids: ['a@g.us', 'b@g.us'] })
    expect(res.statusCode).toBe(409)
    expect(res.json().conflicts).toEqual([{ jid: 'a@g.us', name: 'A', tenantName: 'One' }])
    expect((await call('PUT', `/api/tenants/${t2}/groups`, { jids: ['nope@g.us'] })).statusCode).toBe(400)
    expect((await call('PUT', `/api/tenants/${t2}/groups`, { jids: ['b@g.us'] })).json()).toEqual({ ok: true })
    expect((await call('PUT', '/api/tenants/9999/groups', { jids: [] })).statusCode).toBe(404)
    expect(t1).toBeGreaterThan(0)
  })

  it('reorders triggers and rejects a foreign id', async () => {
    seedGroup('a@g.us', 'A')
    const t = seedTenant('One', ['a@g.us'])
    const other = seedTenant('Other', [])
    const x = seedQaTrigger(t, 'a@g.us', { name: 'X' })
    const y = seedQaTrigger(t, 'a@g.us', { name: 'Y' })
    const foreign = seedQaTrigger(other, 'a@g.us', { name: 'F' })
    expect((await call('PUT', `/api/tenants/${t}/trigger-order`, { ids: [y, x] })).json()).toEqual({ ok: true })
    expect(listTriggers(t).map(r => r.id)).toEqual([y, x])
    expect((await call('PUT', `/api/tenants/${t}/trigger-order`, { ids: [y, foreign] })).statusCode).toBe(400)
    expect((await call('PUT', `/api/tenants/${t}/trigger-order`, { ids: [y] })).statusCode).toBe(400)
  })

  it('creates, reads, updates, toggles and deletes a trigger', async () => {
    seedGroup('a@g.us', 'A')
    const t = seedTenant('One', ['a@g.us'])
    const created = await call('POST', `/api/tenants/${t}/triggers`, {
      type: 'qa', name: 'Mine', enabled: false, config: { qaGroupJid: 'a@g.us', waitSeconds: 3 },
    })
    expect(created.statusCode).toBe(200)
    const id = created.json().id as number
    expect(getTrigger(id)).toMatchObject({ name: 'Mine', enabled: false, type: 'qa' })

    const got = (await call('GET', `/api/triggers/${id}`)).json()
    expect(got.trigger).toMatchObject({ id, tenantId: t, type: 'qa', name: 'Mine', enabled: false })
    expect(got.trigger.config.waitSeconds).toBe(3)
    expect(got.tenant).toEqual({ id: t, name: 'One' })
    expect(got.coveredGroups).toEqual([{ jid: 'a@g.us', name: 'A' }])
    expect(got.type).toMatchObject({
      id: 'qa', displayName: 'Questions', defaultPrompt: DEFAULT_QA_SYSTEM_PROMPT,
      defaultErrorTemplate: QA_DEFAULT_ERROR_TEMPLATE,
    })
    expect(got.type.defaults.maxAgeMinutes).toBe(10)

    const upd = await call('PUT', `/api/triggers/${id}`, {
      name: 'Renamed', enabled: true, config: { qaGroupJid: 'a@g.us', waitSeconds: 0 },
    })
    expect(upd.json()).toEqual({ ok: true })
    expect(getTrigger(id)).toMatchObject({ name: 'Renamed', enabled: true })

    expect((await call('PATCH', `/api/triggers/${id}/enabled`, { enabled: false })).json()).toEqual({ ok: true })
    expect(getTrigger(id)!.enabled).toBe(false)

    expect((await call('DELETE', `/api/triggers/${id}`)).json()).toEqual({ ok: true })
    expect(getTrigger(id)).toBeNull()
    expect((await call('GET', `/api/triggers/${id}`)).statusCode).toBe(404)
    expect((await call('DELETE', `/api/triggers/${id}`)).statusCode).toBe(404)
  })

  it('returns 400 with the validate message, and for a bad name or type', async () => {
    seedGroup('a@g.us', 'A')
    seedGroup('out@g.us', 'Out')
    const t = seedTenant('One', ['a@g.us'])
    const bad = await call('POST', `/api/tenants/${t}/triggers`, {
      type: 'qa', name: 'N', enabled: true, config: { qaGroupJid: 'out@g.us' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('Pick a group that belongs to this tenant')
    expect((await call('POST', `/api/tenants/${t}/triggers`, { type: 'qa', name: '', enabled: true, config: { qaGroupJid: 'a@g.us' } })).statusCode).toBe(400)
    expect((await call('POST', `/api/tenants/${t}/triggers`, { type: 'zzz', name: 'N', enabled: true, config: {} })).statusCode).toBe(400)
    const id = seedQaTrigger(t, 'a@g.us')
    const upd = await call('PUT', `/api/triggers/${id}`, { name: 'N', enabled: true, config: { qaGroupJid: 'out@g.us' } })
    expect(upd.statusCode).toBe(400)
    expect(upd.json().error).toBe('Pick a group that belongs to this tenant')
  })

  it('keeps a trigger switched off unless the request says otherwise', async () => {
    seedGroup('a@g.us', 'A')
    const t = seedTenant('One', ['a@g.us'])
    const id = seedQaTrigger(t, 'a@g.us', { enabled: false })
    const config = { qaGroupJid: 'a@g.us' }
    expect((await call('PUT', `/api/triggers/${id}`, { name: 'N', config })).statusCode).toBe(200)
    expect(getTrigger(id)!.enabled).toBe(false)
    const bad = await call('PUT', `/api/triggers/${id}`, { name: 'N', enabled: 'no', config })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('The enabled value must be true or false')
    const badPost = await call('POST', `/api/tenants/${t}/triggers`, { type: 'qa', name: 'N', enabled: 1, config })
    expect(badPost.statusCode).toBe(400)
    expect(badPost.json().error).toBe('The enabled value must be true or false')
    const created = await call('POST', `/api/tenants/${t}/triggers`, { type: 'qa', name: 'N', config })
    expect(getTrigger(created.json().id)!.enabled).toBe(true)
  })

  it('describes a trigger type for the new-trigger page', async () => {
    seedGroup('a@g.us', 'A')
    const t = seedTenant('One', ['a@g.us'])
    const res = await call('GET', `/api/trigger-types/qa?tenant=${t}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().type.id).toBe('qa')
    expect(res.json().coveredGroups).toEqual([{ jid: 'a@g.us', name: 'A' }])
    expect((await call('GET', `/api/trigger-types/zzz?tenant=${t}`)).statusCode).toBe(404)
    expect((await call('GET', '/api/trigger-types/qa?tenant=9999')).statusCode).toBe(404)
  })

  it('/api/groups rows carry tenantId and tenantName, also for a community child', async () => {
    seedGroup('c@g.us', 'Comm', { isCommunity: true })
    seedGroup('k@g.us', 'Kid', { parentCommunityJid: 'c@g.us' })
    seedGroup('free@g.us', 'Free')
    const t = seedTenant('Alpha', ['c@g.us'])
    const rows = (await call('GET', '/api/groups')).json().groups as Array<{ jid: string; tenantId: number | null; tenantName: string | null }>
    const by = Object.fromEntries(rows.map(r => [r.jid, r]))
    expect(by['k@g.us']).toMatchObject({ tenantId: t, tenantName: 'Alpha' })
    expect(by['c@g.us']).toMatchObject({ tenantId: t, tenantName: 'Alpha' })
    expect(by['free@g.us']).toMatchObject({ tenantId: null, tenantName: null })
  })

  it('group detail names the group tenant, directly or through its community, or null', async () => {
    seedGroup('c@g.us', 'Comm', { isCommunity: true })
    seedGroup('k1@g.us', 'Kid1', { parentCommunityJid: 'c@g.us' })
    seedGroup('solo@g.us', 'Solo')
    seedGroup('free@g.us', 'Free')
    const t = seedTenant('Alpha', ['c@g.us', 'solo@g.us'])
    const detail = async (jid: string) => (await call('GET', `/api/groups/${encodeURIComponent(jid)}`)).json().group.tenant
    expect(await detail('k1@g.us')).toEqual({ id: t, name: 'Alpha' })
    expect(await detail('solo@g.us')).toEqual({ id: t, name: 'Alpha' })
    expect(await detail('free@g.us')).toBeNull()
  })
})
