import type { FastifyInstance } from 'fastify'
import { createApp } from '../../src/web/server.js'
import { config } from '../../src/config.js'

export async function buildTestApp(): Promise<FastifyInstance> {
  config.adminPassword = 'test-password'
  return createApp()
}

/** GET /login for a session + CSRF token, then POST credentials.
 *  Returns the session cookie and csrf token for authenticated requests. */
export async function loginTestApp(app: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
  const loginPage = await app.inject({ method: 'GET', url: '/login' })
  const setCookie = loginPage.headers['set-cookie']
  let cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie!).split(';')[0]
  const csrf = /name="_csrf" value="([^"]*)"/.exec(loginPage.body)?.[1]
    ?? /name="csrf-token" content="([^"]*)"/.exec(loginPage.body)?.[1] ?? ''

  const res = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `username=admin&password=test-password&_csrf=${encodeURIComponent(csrf)}`,
  })
  const setCookie2 = res.headers['set-cookie']
  if (setCookie2) cookie = (Array.isArray(setCookie2) ? setCookie2[0] : setCookie2).split(';')[0]
  return { cookie, csrf }
}
