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

  it('redirects both pages to /login when unauthenticated', async () => {
    expect((await app.inject({ method: 'GET', url: '/tenants' })).statusCode).toBe(302)
    expect((await app.inject({ method: 'GET', url: '/tenants/1' })).statusCode).toBe(302)
    expect((await app.inject({ method: 'GET', url: '/tenants/1/triggers/new?type=qa' })).statusCode).toBe(302)
    expect((await app.inject({ method: 'GET', url: '/tenants/1/triggers/2' })).statusCode).toBe(302)
  })
})
