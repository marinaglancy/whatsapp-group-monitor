import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import type { FastifyInstance } from 'fastify'
import { setupTestDbs, TEST_PHONE } from '../helpers/db.js'
import { seedGroup, seedUser, seedMember, seedMessage } from '../helpers/fixtures.js'
import { makePreBotBackup } from '../helpers/backup.js'
import { buildTestApp, loginTestApp } from '../helpers/web.js'
import { mergeAccountDb } from '../../src/web/routes/backup.js'
import { replaceAccountDbFile, getAccountDb } from '../../src/db/account.js'
import { getGroup, updateGroupQaConfig } from '../../src/db/queries/groups.js'
import { insertJob, listJobs } from '../../src/db/queries/jobs.js'
import { executeQaTool } from '../../src/ai/tools/executors.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs() })
afterEach(() => { dbs.cleanup() })

const NOW_S = Math.floor(Date.now() / 1000)

/** How many messages the bot's message_search tool finds for a word. */
function searchHits(word: string, groupJids: string[]): number {
  const ctx = { scope: { entries: [], groupJids, names: new Map(), qaInstructions: null }, timezone: 'UTC', nowMs: () => Date.now() }
  const out = JSON.parse(executeQaTool('message_search', { query: [`"${word}"`] }, ctx).result)
  if (out.error) throw new Error(out.error)
  return out.total
}

function rowCounts(): Record<string, number> {
  const db = getAccountDb()
  const count = (t: string) => (db.$client.prepare(`select count(*) n from ${t}`).get() as { n: number }).n
  return Object.fromEntries(['users', 'groups', 'group_members', 'group_activity_log', 'bot_jobs'].map(t => [t, count(t)]))
}

describe('restore by merge', () => {
  it('merges a backup made before the bot existed, keeping the bot data already here', () => {
    seedGroup('qa@g.us', 'Admins')
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['old@g.us'] })
    insertJob({ jobType: 'qa_answer', groupJid: 'qa@g.us', messageId: 'Q1', runAt: NOW_S })
    const backup = join(dbs.dir, 'pre-bot.db')
    makePreBotBackup(backup, 'lighthouse')

    mergeAccountDb(TEST_PHONE, backup)

    expect(getGroup('old@g.us')!.name).toBe('Old Group')
    expect(getGroup('qa@g.us')!.qaLinkedJids).toEqual(['old@g.us']) // live bot settings kept
    expect(listJobs({ limit: 10, offset: 0 }).total).toBe(1)          // live job history kept
    expect(rowCounts()).toMatchObject({ users: 1, group_members: 1, group_activity_log: 1 })
  })

  it('makes merged messages findable by the bot search', () => {
    const backup = join(dbs.dir, 'pre-bot.db')
    makePreBotBackup(backup, 'lighthouse')
    mergeAccountDb(TEST_PHONE, backup)
    expect(searchHits('lighthouse', ['old@g.us'])).toBe(1)
  })

  it('adds nothing when the same backup is merged twice', () => {
    const backup = join(dbs.dir, 'pre-bot.db')
    makePreBotBackup(backup, 'lighthouse')
    mergeAccountDb(TEST_PHONE, backup)
    const once = rowCounts()
    mergeAccountDb(TEST_PHONE, backup)
    expect(rowCounts()).toEqual(once)
    expect(searchHits('lighthouse', ['old@g.us'])).toBe(1)
  })
})

describe('restore by replace', () => {
  it('upgrades a backup made before the bot existed when the app opens it', () => {
    const backup = join(dbs.dir, 'pre-bot.db')
    makePreBotBackup(backup, 'lighthouse')

    replaceAccountDbFile(TEST_PHONE, backup) // reopens the database, which runs the upgrades

    // per-group bot settings work (column added)
    updateGroupQaConfig('old@g.us', { enabled: true, linkedJids: [] })
    expect(getGroup('old@g.us')!.qaEnabled).toBe(true)
    // bot jobs work (tables added)
    expect(insertJob({ jobType: 'qa_answer', groupJid: 'old@g.us', messageId: 'Q1', runAt: NOW_S })).not.toBeNull()
    // old messages are searchable (index built from the restored rows)
    expect(searchHits('lighthouse', ['old@g.us'])).toBe(1)
  })
})

describe('backup and restore through the web pages', () => {
  let app: FastifyInstance
  let auth: { cookie: string; csrf: string }
  beforeEach(async () => { app = await buildTestApp(); auth = await loginTestApp(app) })
  afterEach(async () => { await app.close() })

  it('gets back exactly what was downloaded: download, upload, restore by replace', async () => {
    seedGroup('g1@g.us', 'Hiking')
    seedUser('u1@lid', 'Ana', '351910000001')
    seedMember('g1@g.us', 'u1@lid')
    seedMessage('g1@g.us', 'u1@lid', 'meet at the lighthouse', NOW_S - 60) // still in the -wal file
    const before = rowCounts()

    const download = await app.inject({
      method: 'POST', url: '/backup/download',
      headers: { cookie: auth.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `items=${encodeURIComponent(`phone:${TEST_PHONE}`)}&_csrf=${encodeURIComponent(auth.csrf)}`,
    })
    expect(download.statusCode).toBe(200)

    // changes after the backup must disappear on a replace
    seedMessage('g1@g.us', 'u1@lid', 'written after the backup', NOW_S)

    const form = new FormData()
    form.append('file', new Blob([download.rawPayload], { type: 'application/zip' }), 'backup.zip')
    const upload = await app.inject({
      method: 'POST', url: '/backup/upload',
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf },
      payload: form,
    })
    expect(upload.statusCode).toBe(200)
    const { token, items } = upload.json() as { token: string; items: { id: string }[] }
    expect(items.map(i => i.id)).toEqual([`phone:${TEST_PHONE}`])

    const restore = await app.inject({
      method: 'POST', url: '/backup/restore',
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' },
      payload: { token, choices: { [`phone:${TEST_PHONE}`]: 'replace' } },
    })
    expect(restore.json()).toMatchObject({ ok: true })

    expect(rowCounts()).toEqual(before)
    expect(searchHits('lighthouse', ['g1@g.us'])).toBe(1)
    expect(searchHits('written', ['g1@g.us'])).toBe(0)
  })
})
