import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { setupTestDbs } from '../helpers/db.js'
import { buildTestApp, loginTestApp } from '../helpers/web.js'
import { seedGroup } from '../helpers/fixtures.js'
import { getGroup, updateGroupQaConfig } from '../../src/db/queries/groups.js'

let dbs: ReturnType<typeof setupTestDbs>
let app: FastifyInstance
let auth: { cookie: string; csrf: string }

beforeEach(async () => {
  dbs = setupTestDbs()
  seedGroup('qa@g.us', 'Admins')
  seedGroup('comm@g.us', 'Hive', { isCommunity: true })
  seedGroup('a@g.us', 'Alpha', { parentCommunityJid: 'comm@g.us' })
  app = await buildTestApp()
  auth = await loginTestApp(app)
})
afterEach(async () => { await app.close(); dbs.cleanup() })

const post = (jid: string, payload: unknown, csrf = true) => app.inject({
  method: 'POST',
  url: `/api/groups/${encodeURIComponent(jid)}/bot`,
  headers: { cookie: auth.cookie, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': auth.csrf } : {}) },
  payload: payload as never,
})

describe('POST /api/groups/:jid/bot', () => {
  it('saves config', async () => {
    const res = await post('qa@g.us', { qaEnabled: true, qaLinkedJids: ['comm@g.us', 'a@g.us'] })
    expect(res.statusCode).toBe(200)
    const g = getGroup('qa@g.us')!
    expect(g.qaEnabled).toBe(true)
    expect(g.qaLinkedJids).toEqual(['comm@g.us', 'a@g.us'])
  })

  it('rejects missing CSRF, unknown group, community targets and bad payloads', async () => {
    expect((await post('qa@g.us', { qaEnabled: true, qaLinkedJids: [] }, false)).statusCode).toBe(403)
    expect((await post('nope@g.us', { qaEnabled: true, qaLinkedJids: [] })).statusCode).toBe(404)
    expect((await post('comm@g.us', { qaEnabled: true, qaLinkedJids: [] })).statusCode).toBe(400)
    expect((await post('qa@g.us', { qaEnabled: 'yes', qaLinkedJids: [] })).statusCode).toBe(400)
    expect((await post('qa@g.us', { qaEnabled: true, qaLinkedJids: [1] })).statusCode).toBe(400)
    expect((await post('qa@g.us', { qaEnabled: true, qaLinkedJids: ['ghost@g.us'] })).statusCode).toBe(400)
  })

  it('disabling keeps the linked list it was sent', async () => {
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['a@g.us'] })
    await post('qa@g.us', { qaEnabled: false, qaLinkedJids: ['a@g.us'] })
    const g = getGroup('qa@g.us')!
    expect(g.qaEnabled).toBe(false)
    expect(g.qaLinkedJids).toEqual(['a@g.us'])
  })

  it('round-trips instructions and rejects over-long or non-string ones', async () => {
    const ok = await post('qa@g.us', { qaEnabled: true, qaLinkedJids: ['a@g.us'], qaInstructions: '  Be terse.  ' })
    expect(ok.statusCode).toBe(200)
    expect(getGroup('qa@g.us')!.qaInstructions).toBe('Be terse.')
    // blank clears
    await post('qa@g.us', { qaEnabled: true, qaLinkedJids: ['a@g.us'], qaInstructions: '' })
    expect(getGroup('qa@g.us')!.qaInstructions).toBeNull()
    expect((await post('qa@g.us', { qaEnabled: true, qaLinkedJids: [], qaInstructions: 'x'.repeat(4001) })).statusCode).toBe(400)
    expect((await post('qa@g.us', { qaEnabled: true, qaLinkedJids: [], qaInstructions: 42 })).statusCode).toBe(400)
  })
})
