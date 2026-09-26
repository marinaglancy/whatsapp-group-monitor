import Fastify from 'fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'
import fastifyFormbody from '@fastify/formbody'
import fastifyMultipart from '@fastify/multipart'
import { readFileSync, readdirSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import { getSettingOrDefault } from '../db/queries/settings.js'
import { registerRoutes } from './routes/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const staticDir = resolve(__dirname, 'static')

function resolvePartials(html: string): string {
  return html.replace(/\{\{>\s*(\S+)\s*\}\}/g, (_, name) => {
    const partialPath = resolve(staticDir, 'partials', `${name}.html`)
    return readFileSync(partialPath, 'utf-8')
  })
}

export function sendPage(reply: FastifyReply, filename: string, req?: FastifyRequest) {
  const csrfToken = req?.session?.csrfToken || ''
  const html = resolvePartials(readFileSync(resolve(staticDir, filename), 'utf-8'))
    .replaceAll('{{PROJECT_NAME}}', getSettingOrDefault('project_name', 'WhatsApp Group Monitor'))
    .replaceAll('{{CSRF_TOKEN}}', csrfToken)
    .replaceAll('{{ADMIN_USERNAME}}', config.adminUsername)
    .replaceAll('{{PAGE_SIZE}}', getSettingOrDefault('page_size', '50'))
  return reply.type('text/html').send(html)
}

export function cleanupTmpUploads() {
  const tmpDir = resolve(config.dataDir, '.tmp')
  try {
    for (const f of readdirSync(tmpDir)) {
      try { unlinkSync(resolve(tmpDir, f)) } catch { /* ignore */ }
    }
  } catch { /* dir may not exist yet */ }
}

export async function createApp() {
  const app = Fastify({ logger: false })

  await app.register(fastifyFormbody)
  await app.register(fastifyMultipart, { limits: { fileSize: 200 * 1024 * 1024 } })
  await app.register(fastifyCookie)
  await app.register(fastifySession, {
    secret: config.sessionSecret,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    },
    cookieName: 'session',
  })

  await app.register(fastifyStatic, {
    root: resolve(__dirname, 'static'),
    prefix: '/static/',
  })

  registerRoutes(app)
  return app
}

export async function startWebServer() {
  cleanupTmpUploads()
  const app = await createApp()
  await app.listen({ port: config.port, host: config.host })
  logger.info(`Web server listening on http://${config.host}:${config.port}`)
}
