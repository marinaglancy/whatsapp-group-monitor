import type { FastifyInstance } from 'fastify'
import { readdirSync, existsSync, statSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { PassThrough, pipeline as streamPipeline } from 'stream'
import { promisify } from 'util'
import { createWriteStream } from 'fs'
import crypto from 'crypto'
import { ZipArchive } from 'archiver'
import AdmZip from 'adm-zip'
import Database from 'better-sqlite3'
import { config } from '../../config.js'
import { logger } from '../../utils/logger.js'
import { sendPage, cleanupTmpUploads } from '../server.js'
import { requireAuth, requireAuthApi, generateCsrf, verifyCsrf } from '../middleware/auth.js'
import { checkpointSharedDb } from '../../db/shared.js'
import { checkpointAccountDb, getAccountPhone, replaceAccountDbFile } from '../../db/account.js'
import { setSetting } from '../../db/queries/settings.js'
import { getSock } from '../../whatsapp/client.js'
import { getConnectionState } from '../../whatsapp/handlers/connection.js'
import { syncGroups } from '../../whatsapp/handlers/group-sync.js'

const pipeline = promisify(streamPipeline)

function discoverPhones(): string[] {
  try {
    return readdirSync(config.dataDir).filter(entry => {
      const dir = resolve(config.dataDir, entry)
      return statSync(dir).isDirectory() && existsSync(resolve(dir, 'account.db'))
    })
  } catch {
    return []
  }
}

function tmpDir(): string {
  const dir = resolve(config.dataDir, '.tmp')
  mkdirSync(dir, { recursive: true })
  return dir
}

function restoreSettings(backupDbPath: string) {
  const backupDb = new Database(backupDbPath, { readonly: true })
  const rows = backupDb.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  backupDb.close()
  for (const { key, value } of rows) {
    setSetting(key, value)
  }
}

export function mergeAccountDb(phone: string, backupDbPath: string) {
  const mainDbPath = resolve(config.dataDir, phone, 'account.db')
  const db = new Database(mainDbPath)
  db.pragma('foreign_keys = OFF')
  const escaped = backupDbPath.replace(/'/g, "''")
  db.exec(`ATTACH DATABASE '${escaped}' AS backup`)

  db.transaction(() => {
    // Insert new users; then merge fields for existing ones via correlated UPDATE
    db.exec(`
      INSERT OR IGNORE INTO users (jid, phone_number, is_banned, display_name, display_name_updated_at, created_at, updated_at)
      SELECT jid, phone_number, is_banned, display_name, display_name_updated_at, created_at, updated_at
      FROM backup.users
    `)
    db.exec(`
      UPDATE users SET
        phone_number            = COALESCE(phone_number, (SELECT b.phone_number FROM backup.users b WHERE b.jid = users.jid)),
        display_name            = COALESCE(display_name, (SELECT b.display_name FROM backup.users b WHERE b.jid = users.jid)),
        display_name_updated_at = (SELECT CASE
          WHEN users.display_name_updated_at IS NULL THEN b.display_name_updated_at
          WHEN b.display_name_updated_at IS NULL   THEN users.display_name_updated_at
          WHEN b.display_name_updated_at > users.display_name_updated_at THEN b.display_name_updated_at
          ELSE users.display_name_updated_at END
          FROM backup.users b WHERE b.jid = users.jid),
        created_at              = (SELECT MIN(users.created_at, b.created_at) FROM backup.users b WHERE b.jid = users.jid),
        updated_at              = (SELECT MAX(users.updated_at, b.updated_at) FROM backup.users b WHERE b.jid = users.jid)
      WHERE jid IN (SELECT jid FROM backup.users)
    `)

    // groups: schemas may differ across versions (e.g. bot_config added in an
    // upgrade), so insert by the intersection of backup and live columns —
    // never positionally
    const liveGroupCols = (db.pragma('table_info(groups)') as { name: string }[]).map(c => c.name)
    const backupGroupCols = (db.pragma('backup.table_info(groups)') as { name: string }[]).map(c => c.name)
    const groupCols = backupGroupCols.filter(c => liveGroupCols.includes(c)).map(c => `"${c}"`).join(', ')
    db.exec(`INSERT OR IGNORE INTO groups (${groupCols}) SELECT ${groupCols} FROM backup.groups`)

    // Insert new memberships; then merge timestamp fields for existing ones
    db.exec(`
      INSERT OR IGNORE INTO group_members (group_jid, user_jid, membership, joined_at, left_at, updated_at, last_read_at)
      SELECT group_jid, user_jid, membership, joined_at, left_at, updated_at, last_read_at
      FROM backup.group_members
    `)
    db.exec(`
      UPDATE group_members SET
        joined_at    = (SELECT CASE
          WHEN group_members.joined_at IS NULL THEN b.joined_at
          WHEN b.joined_at IS NULL              THEN group_members.joined_at
          WHEN b.joined_at < group_members.joined_at THEN b.joined_at
          ELSE group_members.joined_at END
          FROM backup.group_members b WHERE b.group_jid = group_members.group_jid AND b.user_jid = group_members.user_jid),
        updated_at   = (SELECT MAX(group_members.updated_at, b.updated_at)
          FROM backup.group_members b WHERE b.group_jid = group_members.group_jid AND b.user_jid = group_members.user_jid),
        last_read_at = (SELECT CASE
          WHEN group_members.last_read_at IS NULL THEN b.last_read_at
          WHEN b.last_read_at IS NULL              THEN group_members.last_read_at
          WHEN b.last_read_at > group_members.last_read_at THEN b.last_read_at
          ELSE group_members.last_read_at END
          FROM backup.group_members b WHERE b.group_jid = group_members.group_jid AND b.user_jid = group_members.user_jid)
      WHERE EXISTS (
        SELECT 1 FROM backup.group_members b
        WHERE b.group_jid = group_members.group_jid AND b.user_jid = group_members.user_jid
      )
    `)

    db.exec(`
      INSERT OR IGNORE INTO group_activity_log
        (group_jid, user_jid, message_id, parent_id, event_type, metadata, raw, timestamp, created_at)
      SELECT group_jid, user_jid, message_id, parent_id, event_type, metadata, raw, timestamp, created_at
      FROM backup.group_activity_log
    `)
  })()

  db.exec('DETACH DATABASE backup')
  db.pragma('foreign_keys = ON')
  db.close()
}

export function registerBackupRoutes(app: FastifyInstance) {
  app.get('/backup', { preHandler: requireAuth }, async (req, reply) => {
    generateCsrf(req)
    return sendPage(reply, 'backup.html', req)
  })

  app.get('/api/backup/items', { preHandler: requireAuthApi }, async (_req, reply) => {
    const items = [{ id: 'settings', label: 'Settings' }]
    for (const phone of discoverPhones()) {
      items.push({ id: `phone:${phone}`, label: `Data for +${phone}` })
    }
    return reply.send({ items })
  })

  app.post('/backup/download', { preHandler: requireAuth }, async (req, reply) => {
    if (!verifyCsrf(req)) {
      return reply.status(403).send('Invalid CSRF token')
    }

    const body = req.body as Record<string, string | string[]>
    const rawItems = body.items
    const selected: string[] = rawItems
      ? Array.isArray(rawItems) ? rawItems : [rawItems]
      : []

    const date = new Date().toISOString().slice(0, 10)
    reply.header('Content-Type', 'application/zip')
    reply.header('Content-Disposition', `attachment; filename="backup-${date}.zip"`)

    const pass = new PassThrough()
    const archive = new ZipArchive({ zlib: { level: 6 } })
    archive.pipe(pass)
    archive.on('error', (err) => pass.destroy(err))

    if (selected.includes('settings')) {
      checkpointSharedDb()
      const dbPath = resolve(config.dataDir, 'monitor.db')
      if (existsSync(dbPath)) {
        archive.file(dbPath, { name: 'settings/monitor.db' })
      }
    }

    const currentPhone = getAccountPhone()
    for (const item of selected) {
      if (!item.startsWith('phone:')) continue
      const phone = item.slice('phone:'.length)
      const dbPath = resolve(config.dataDir, phone, 'account.db')
      if (!existsSync(dbPath)) continue
      if (phone === currentPhone) checkpointAccountDb()
      archive.file(dbPath, { name: `${phone}/account.db` })
    }

    archive.finalize()
    return reply.send(pass)
  })

  app.post('/backup/upload', { preHandler: requireAuthApi }, async (req, reply) => {
    if (!verifyCsrf(req)) {
      return reply.status(403).send({ error: 'Invalid CSRF token' })
    }

    const data = await req.file()
    if (!data) return reply.status(400).send({ error: 'No file uploaded' })

    cleanupTmpUploads()
    const token = crypto.randomUUID()
    const zipPath = resolve(tmpDir(), `${token}.zip`)

    try {
      await pipeline(data.file, createWriteStream(zipPath))
    } catch {
      return reply.status(400).send({ error: 'Failed to save uploaded file' })
    }

    let zip: AdmZip
    try {
      zip = new AdmZip(zipPath)
    } catch {
      try { unlinkSync(zipPath) } catch { /* ignore */ }
      return reply.status(400).send({ error: 'Invalid zip file' })
    }

    const entryNames = zip.getEntries().map(e => e.entryName)
    const items: { id: string; label: string; hasExisting: boolean }[] = []

    if (entryNames.includes('settings/monitor.db')) {
      items.push({
        id: 'settings',
        label: 'Settings',
        hasExisting: existsSync(resolve(config.dataDir, 'monitor.db')),
      })
    }

    for (const entry of entryNames) {
      const m = entry.match(/^([^/]+)\/account\.db$/)
      if (m) {
        const phone = m[1]
        items.push({
          id: `phone:${phone}`,
          label: `Data for +${phone}`,
          hasExisting: existsSync(resolve(config.dataDir, phone, 'account.db')),
        })
      }
    }

    return reply.send({ token, items })
  })

  app.post('/backup/restore', { preHandler: requireAuthApi }, async (req, reply) => {
    if (!verifyCsrf(req)) {
      return reply.status(403).send({ error: 'Invalid CSRF token' })
    }

    const { token, choices } = req.body as { token: string; choices: Record<string, string> }

    if (!token || !/^[0-9a-f-]{36}$/.test(token)) {
      return reply.status(400).send({ error: 'Invalid token' })
    }

    const zipPath = resolve(config.dataDir, '.tmp', `${token}.zip`)
    if (!existsSync(zipPath)) {
      return reply.status(404).send({ error: 'Upload not found — please upload the file again' })
    }

    let zip: AdmZip
    try {
      zip = new AdmZip(zipPath)
    } catch {
      return reply.status(400).send({ error: 'Invalid zip file' })
    }

    const details: string[] = []
    const errors: string[] = []
    const tmp = tmpDir()

    try {
      for (const [id, action] of Object.entries(choices)) {
        if (action === 'ignore') continue

        if (id === 'settings') {
          const entry = zip.getEntry('settings/monitor.db')
          if (!entry) continue
          const tmpPath = resolve(tmp, `${token}-settings.db`)
          writeFileSync(tmpPath, entry.getData())
          try {
            restoreSettings(tmpPath)
            details.push('Settings restored')
          } catch (err) {
            logger.error({ err }, 'Failed to restore settings')
            errors.push(`Settings: ${err instanceof Error ? err.message : String(err)}`)
          } finally {
            for (const ext of ['', '-wal', '-shm']) {
              try { unlinkSync(tmpPath + ext) } catch { /* ignore */ }
            }
          }
        } else if (id.startsWith('phone:')) {
          const phone = id.slice('phone:'.length)
          const entry = zip.getEntry(`${phone}/account.db`)
          if (!entry) continue
          const tmpPath = resolve(tmp, `${token}-${phone}.db`)
          writeFileSync(tmpPath, entry.getData())
          try {
            if (action === 'merge') {
              mergeAccountDb(phone, tmpPath)
              details.push(`Data for +${phone} merged`)
            } else {
              replaceAccountDbFile(phone, tmpPath)
              details.push(`Data for +${phone} restored`)
            }
          } catch (err) {
            logger.error({ err, phone, action }, 'Failed to restore phone data')
            errors.push(`+${phone}: ${err instanceof Error ? err.message : String(err)}`)
          } finally {
            for (const ext of ['', '-wal', '-shm']) {
              try { unlinkSync(tmpPath + ext) } catch { /* ignore */ }
            }
          }
        }
      }
    } finally {
      try { unlinkSync(zipPath) } catch { /* ignore */ }
    }

    if (errors.length) {
      return reply.status(500).send({ ok: false, details, error: errors.join('; ') })
    }

    // After restore perform a group sync if the current phone's data was affected and we're
    // connected to WhatsApp, to update any changed group/user info in memory
    const currentPhone = getAccountPhone()
    const restoredPhones = Object.entries(choices)
      .filter(([id, action]) => id.startsWith('phone:') && action !== 'ignore')
      .map(([id]) => id.slice('phone:'.length))

    if (currentPhone && restoredPhones.includes(currentPhone) && getConnectionState() === 'open') {
      syncGroups(getSock()).catch(err => logger.error({ err }, 'Group resync after restore failed'))
    }

    return reply.send({ ok: true, details })
  })
}
