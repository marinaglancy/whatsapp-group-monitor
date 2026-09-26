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

describe('POST /api/resync', () => {
  it('requires auth', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/resync' })).statusCode).toBe(401)
  })

  it('requires CSRF', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/resync', headers: { cookie: auth.cookie } })
    expect(res.statusCode).toBe(403)
  })

  it('returns 503 when WhatsApp is not connected', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/resync',
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    })
    expect(res.statusCode).toBe(503)
  })
})
