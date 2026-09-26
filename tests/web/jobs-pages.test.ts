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

describe('jobs pages', () => {
  it('serves /jobs with the jobs table container and nav link', async () => {
    const res = await app.inject({ method: 'GET', url: '/jobs', headers: { cookie: auth.cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="jobs"')
    expect(res.body).toContain('href="/jobs"') // kebab menu link from the shared partial
  })

  it('serves /job/:id with the detail container', async () => {
    const res = await app.inject({ method: 'GET', url: '/job/1', headers: { cookie: auth.cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="job-detail"')
  })

  it('redirects both pages to /login when unauthenticated', async () => {
    expect((await app.inject({ method: 'GET', url: '/jobs' })).statusCode).toBe(302)
    expect((await app.inject({ method: 'GET', url: '/job/1' })).statusCode).toBe(302)
  })
})
