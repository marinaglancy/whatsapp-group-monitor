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

describe('backup page', () => {
  it('warns that settings backups contain stored API keys', async () => {
    const res = await app.inject({ method: 'GET', url: '/backup', headers: { cookie: auth.cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('API key')
  })
})
