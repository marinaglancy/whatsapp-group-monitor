import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { setupTestDbs } from '../helpers/db.js'
import { buildTestApp, loginTestApp } from '../helpers/web.js'
import { getSetting } from '../../src/db/queries/settings.js'

let dbs: ReturnType<typeof setupTestDbs>
let app: FastifyInstance
let auth: { cookie: string; csrf: string }

beforeEach(async () => {
  dbs = setupTestDbs()
  app = await buildTestApp()
  auth = await loginTestApp(app)
})
afterEach(async () => { await app.close(); dbs.cleanup() })

function post(payload: Record<string, string>) {
  return app.inject({
    method: 'POST', url: '/api/settings',
    headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' },
    payload,
  })
}
const get = () => app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: auth.cookie } })

describe('/api/settings AI keys', () => {
  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' })
    expect(res.statusCode).toBe(401)
  })

  it('reports defaults and gemini_api_key_set=false', async () => {
    const body = (await get()).json()
    expect(body.gemini_api_key_set).toBe(false)
    expect(body.gemini_model).toBe('gemini-3.8-flash')
    expect(body.ai_daily_limit).toBe('300')
    expect('gemini_api_key' in body).toBe(false)
  })

  it('stores the key write-only and reports it set', async () => {
    expect((await post({ gemini_api_key: 'sk-secret' })).statusCode).toBe(200)
    expect(getSetting('gemini_api_key')).toBe('sk-secret')
    const body = (await get()).json()
    expect(body.gemini_api_key_set).toBe(true)
    expect(JSON.stringify(body)).not.toContain('sk-secret')
  })

  it('clears the key on empty string, leaves it on omission', async () => {
    await post({ gemini_api_key: 'sk-secret' })
    await post({ gemini_model: 'gemini-3.7-flash' }) // omitted → unchanged
    expect(getSetting('gemini_api_key')).toBe('sk-secret')
    await post({ gemini_api_key: '' }) // empty → cleared
    expect(getSetting('gemini_api_key')).toBe('')
    expect((await get()).json().gemini_api_key_set).toBe(false)
  })

  it('persists model and daily limit through the whitelist', async () => {
    await post({ gemini_model: 'gemini-3.7-flash', ai_daily_limit: '100' })
    const body = (await get()).json()
    expect(body.gemini_model).toBe('gemini-3.7-flash')
    expect(body.ai_daily_limit).toBe('100')
  })

  it('reports whether the system prompt is the shipped default', async () => {
    expect((await get()).json().ai_system_prompt_is_default).toBe(true)
    await post({ ai_system_prompt: 'You are a pirate.' })
    expect((await get()).json().ai_system_prompt_is_default).toBe(false)
    await post({ ai_system_prompt: '' }) // clearing returns to tracking the default
    expect((await get()).json().ai_system_prompt_is_default).toBe(true)
  })

  it('exposes the effective system prompt and round-trips edits', async () => {
    let body = (await get()).json()
    expect(body.ai_system_prompt).toContain('WhatsApp') // shipped default
    await post({ ai_system_prompt: 'You are a pirate.' })
    body = (await get()).json()
    expect(body.ai_system_prompt).toBe('You are a pirate.')
    await post({ ai_system_prompt: '' }) // clearing restores the default
    body = (await get()).json()
    expect(body.ai_system_prompt).toContain('WhatsApp')
  })

  it('settings page contains the AI assistant section', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings', headers: { cookie: auth.cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="gemini_api_key"')
    expect(res.body).toContain('id="gemini_model"')
    expect(res.body).toContain('id="ai_daily_limit"')
    expect(res.body).toContain('id="ai_system_prompt"')
  })

  it('rejects a POST without CSRF', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/settings',
      headers: { cookie: auth.cookie, 'content-type': 'application/json' },
      payload: { gemini_model: 'x' },
    })
    expect(res.statusCode).toBe(403)
  })
})
