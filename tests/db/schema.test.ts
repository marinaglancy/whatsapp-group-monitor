import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { setupTestDbs, TEST_PHONE } from '../helpers/db.js'
import { config } from '../../src/config.js'
import { getAccountDb, initAccountDb, closeAccountDb } from '../../src/db/account.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs() })
afterEach(() => { dbs.cleanup() })

function tableNames(): string[] {
  const rows = getAccountDb().all(sql`SELECT name FROM sqlite_master WHERE type='table'`) as { name: string }[]
  return rows.map(r => r.name)
}

describe('account db schema', () => {
  it('creates the existing core tables', () => {
    const names = tableNames()
    expect(names).toContain('groups')
    expect(names).toContain('group_activity_log')
  })
})

describe('bot job tables', () => {
  it('creates bot_jobs and bot_job_events', () => {
    const names = tableNames()
    expect(names).toContain('bot_jobs')
    expect(names).toContain('bot_job_events')
  })

  it('adds bot_config to groups', () => {
    const cols = (getAccountDb().all(sql`SELECT name FROM pragma_table_info('groups')`) as { name: string }[]).map(c => c.name)
    expect(cols).toContain('bot_config')
  })

  it('enforces unique (job_type, group_jid, message_id) when message_id is set', () => {
    const db = getAccountDb()
    const ins = sql`INSERT INTO bot_jobs (job_type, group_jid, message_id, run_at, created_at, updated_at)
                    VALUES ('qa_answer', 'g1@g.us', 'M1', 1, 1, 1)`
    db.run(ins)
    let thrown: unknown
    try {
      db.run(ins)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeDefined()
    // drizzle wraps the sqlite error; the UNIQUE detail lives on the cause
    expect(String((thrown as { cause?: unknown }).cause ?? thrown)).toMatch(/UNIQUE/)
  })

  it('allows many jobs with NULL message_id (partial index)', () => {
    const db = getAccountDb()
    const ins = sql`INSERT INTO bot_jobs (job_type, group_jid, run_at, created_at, updated_at)
                    VALUES ('scheduled_action', 'g1@g.us', 1, 1, 1)`
    db.run(ins)
    expect(() => db.run(ins)).not.toThrow()
  })

  it('migrates an existing groups table (adds bot_config)', () => {
    // close the helper-opened DB, then simulate a pre-existing old-schema DB for another phone
    closeAccountDb()
    const phone = '15550000002'
    const dir = join(config.dataDir, phone)
    mkdirSync(dir, { recursive: true })
    const raw = new Database(join(dir, 'account.db'))
    raw.exec(`CREATE TABLE groups (
      jid TEXT PRIMARY KEY, name TEXT NOT NULL, is_community INTEGER NOT NULL DEFAULT 0,
      parent_community_jid TEXT, permissions TEXT, bot_membership TEXT NOT NULL DEFAULT 'none',
      bot_functions INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`)
    raw.close()
    initAccountDb(phone)
    const cols = (getAccountDb().all(sql`SELECT name FROM pragma_table_info('groups')`) as { name: string }[]).map(c => c.name)
    expect(cols).toContain('bot_config')
    closeAccountDb()
    initAccountDb(TEST_PHONE) // restore for afterEach cleanup symmetry
  })
})
