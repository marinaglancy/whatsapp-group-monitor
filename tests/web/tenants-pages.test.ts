import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { setupTestDbs } from '../helpers/db.js'
import { buildTestApp, loginTestApp } from '../helpers/web.js'

let dbs: ReturnType<typeof setupTestDbs>
let app: FastifyInstance
let auth: { cookie: string; csrf: string }

beforeEach(async () => {
  dbs = setupTestDbs()
  app = await buildTestApp()
  auth = await loginTestApp(app)
})
afterEach(async () => { await app.close(); dbs.cleanup() })

describe('tenants pages', () => {
  it('serves /tenants with the list container and the menu link', async () => {
    const res = await app.inject({ method: 'GET', url: '/tenants', headers: { cookie: auth.cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="tenants"')
    expect(res.body).toContain('href="/tenants"')
  })

  it('serves /tenants/:id with the tenant, popup and triggers containers', async () => {
    const res = await app.inject({ method: 'GET', url: '/tenants/1', headers: { cookie: auth.cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="tenant"')
    expect(res.body).toContain('id="groups-popup"')
    expect(res.body).toContain('id="triggers"')
  })

  it('serves the trigger form for a new and an existing trigger', async () => {
    for (const url of ['/tenants/1/triggers/new?type=qa', '/tenants/1/triggers/new?type=spam', '/tenants/1/triggers/2']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: auth.cookie } })
      expect(res.statusCode).toBe(200)
      expect(res.body).toContain('id="trigger-form"')
    }
  })

  it('the trigger page has a Spam form with the groups popup', async () => {
    const res = await app.inject({ method: 'GET', url: '/tenants/1/triggers/new?type=spam', headers: { cookie: auth.cookie } })
    expect(res.body).toContain('draw: spamForm, read: readSpamConfig')
    expect(res.body).toContain('id="spam-groups-popup"')
    expect(res.body).toContain('Post reports and errors to')
  })

  it('drops watched groups that left the tenant and words the note for one or many', () => {
    const ctx: Record<string, never> = {}
    vm.runInNewContext(readFileSync('src/web/static/trigger-helpers.js', 'utf-8') + ';this.split = splitTenantGroups; this.note = droppedGroupsNote', ctx)
    const { split, note } = ctx as unknown as {
      split: (j: string[], g: { jid: string }[]) => { kept: string[]; droppedCount: number }
      note: (n: number) => string
    }
    expect(split(['a@g.us', 'old@g.us', 'gone@g.us'], [{ jid: 'a@g.us' }])).toEqual({ kept: ['a@g.us'], droppedCount: 2 })
    expect(note(0)).toBe('')
    expect(note(1)).toBe('1 group is no longer in this tenant and was removed from the list')
    expect(note(2)).toBe('2 groups are no longer in this tenant and were removed from the list')
  })

  it('builds the watched-groups selection and note for a form with stale groups', () => {
    const ctx: Record<string, unknown> = {}
    vm.runInNewContext(readFileSync('src/web/static/trigger-helpers.js', 'utf-8') + ';this.state = watchedGroupsState', ctx)
    const state = ctx.state as (c: object, g: { jid: string }[]) => { picked: string[]; noteHtml: string }
    const groups = [{ jid: 'a@g.us' }]
    const two = state({ groupsMode: 'only', groupJids: ['a@g.us', 'x@g.us', 'y@g.us'] }, groups)
    expect(two.picked).toEqual(['a@g.us'])
    expect(two.noteHtml).toContain('2 groups are no longer in this tenant and were removed from the list')
    expect(two.noteHtml).not.toContain('class="error"')
    expect(state({ groupsMode: 'except', groupJids: ['x@g.us'] }, groups).noteHtml).toContain('1 group is no longer in this tenant')
    expect(state({ groupsMode: 'all', groupJids: ['x@g.us'] }, groups)).toEqual({ picked: [], noteHtml: '' })
    expect(state({ groupsMode: 'only', groupJids: ['a@g.us'] }, groups).noteHtml).toBe('')
  })

  it('the trigger page loads the helpers file, which is served', async () => {
    const res = await app.inject({ method: 'GET', url: '/tenants/1/triggers/new?type=spam', headers: { cookie: auth.cookie } })
    expect(res.body).toContain('src="/static/trigger-helpers.js"')
    expect((await app.inject({ method: 'GET', url: '/static/trigger-helpers.js' })).statusCode).toBe(200)
  })

  it('redirects both pages to /login when unauthenticated', async () => {
    expect((await app.inject({ method: 'GET', url: '/tenants' })).statusCode).toBe(302)
    expect((await app.inject({ method: 'GET', url: '/tenants/1' })).statusCode).toBe(302)
    expect((await app.inject({ method: 'GET', url: '/tenants/1/triggers/new?type=qa' })).statusCode).toBe(302)
    expect((await app.inject({ method: 'GET', url: '/tenants/1/triggers/2' })).statusCode).toBe(302)
  })
})
