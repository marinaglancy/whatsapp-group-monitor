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

  it('redirects both pages to /login when unauthenticated', async () => {
    expect((await app.inject({ method: 'GET', url: '/tenants' })).statusCode).toBe(302)
    expect((await app.inject({ method: 'GET', url: '/tenants/1' })).statusCode).toBe(302)
  })
})
