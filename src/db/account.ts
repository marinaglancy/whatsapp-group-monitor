import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { resolve } from 'path'
import { mkdirSync, copyFileSync, unlinkSync } from 'fs'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import * as schema from './schema.js'

let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let accountSqlite: InstanceType<typeof Database> | null = null
let currentPhone: string | null = null

export function getAccountDb() {
  if (!db) throw new Error('Account database not initialized (WhatsApp not connected)')
  return db
}

export function isAccountDbReady(): boolean {
  return db !== null
}

export function getAccountPhone(): string | null {
  return currentPhone
}

export function checkpointAccountDb() {
  accountSqlite?.pragma('wal_checkpoint(FULL)')
}

export function initAccountDb(phone: string) {
  // If already open for the same phone, skip
  if (currentPhone === phone && db) return db

  // Close previous if different phone
  closeAccountDb()

  const accountDir = resolve(config.dataDir, phone)
  mkdirSync(accountDir, { recursive: true })

  const dbPath = resolve(accountDir, 'account.db')
  const sqlite = new Database(dbPath)
  accountSqlite = sqlite
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  db = drizzle(sqlite, { schema })

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_community INTEGER NOT NULL DEFAULT 0,
      parent_community_jid TEXT,
      permissions TEXT,
      bot_membership TEXT NOT NULL DEFAULT 'none',
      bot_functions INTEGER NOT NULL DEFAULT 0,
      bot_config TEXT,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      jid TEXT PRIMARY KEY,
      phone_number TEXT,
      is_banned INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      display_name_updated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);

    CREATE TABLE IF NOT EXISTS group_members (
      group_jid TEXT NOT NULL REFERENCES groups(jid),
      user_jid TEXT NOT NULL REFERENCES users(jid),
      membership TEXT NOT NULL DEFAULT 'participant',
      joined_at INTEGER,
      left_at INTEGER,
      updated_at INTEGER NOT NULL,
      last_read_at TEXT,
      PRIMARY KEY (group_jid, user_jid)
    );

    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_jid);

    CREATE TABLE IF NOT EXISTS group_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_jid TEXT NOT NULL,
      user_jid TEXT NOT NULL,
      message_id TEXT NOT NULL,
      parent_id TEXT,
      event_type TEXT NOT NULL,
      metadata TEXT,
      raw TEXT,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_group_message ON group_activity_log(group_jid, message_id);
    CREATE INDEX IF NOT EXISTS idx_activity_group_ts ON group_activity_log(group_jid, timestamp);
    CREATE INDEX IF NOT EXISTS idx_activity_user_group ON group_activity_log(user_jid, group_jid);
    CREATE INDEX IF NOT EXISTS idx_activity_parent ON group_activity_log(parent_id);

    CREATE TABLE IF NOT EXISTS bot_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type TEXT NOT NULL,
      group_jid TEXT,
      user_jid TEXT,
      message_id TEXT,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      run_at INTEGER NOT NULL,
      expires_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      ai_calls INTEGER NOT NULL DEFAULT 0,
      ai_tokens_in INTEGER NOT NULL DEFAULT 0,
      ai_tokens_out INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bot_jobs_status_run ON bot_jobs(status, run_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_jobs_type_group_msg
      ON bot_jobs(job_type, group_jid, message_id) WHERE message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bot_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES bot_jobs(id),
      event_type TEXT NOT NULL,
      group_jid TEXT,
      user_jid TEXT,
      message_id TEXT,
      data TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bot_job_events_job ON bot_job_events(job_id);
    CREATE INDEX IF NOT EXISTS idx_bot_job_events_message ON bot_job_events(message_id);
  `)

  // Migrations: drop columns that are no longer needed
  // SQLite doesn't support DROP COLUMN before 3.35.0, so we use a safe approach
  const columns = sqlite.pragma('table_info(groups)') as { name: string }[]
  const groupCols = columns.map(c => c.name)
  if (groupCols.includes('syncing')) {
    sqlite.exec('ALTER TABLE groups DROP COLUMN syncing')
  }
  if (groupCols.includes('synced_at')) {
    sqlite.exec('ALTER TABLE groups DROP COLUMN synced_at')
  }
  const actCols = (sqlite.pragma('table_info(group_activity_log)') as { name: string }[]).map(c => c.name)
  if (actCols.includes('processed')) {
    sqlite.exec('ALTER TABLE group_activity_log DROP COLUMN processed')
  }

  const memberCols = (sqlite.pragma('table_info(group_members)') as { name: string }[]).map(c => c.name)
  if (!memberCols.includes('last_read_at')) {
    sqlite.exec('ALTER TABLE group_members ADD COLUMN last_read_at TEXT')
  }

  if (!groupCols.includes('bot_config')) {
    sqlite.exec('ALTER TABLE groups ADD COLUMN bot_config TEXT')
  }

  currentPhone = phone
  logger.info({ phone, path: dbPath }, 'Account database initialized')
  return db
}

export function replaceAccountDbFile(phone: string, srcPath: string) {
  const wasCurrentPhone = currentPhone === phone
  if (wasCurrentPhone) closeAccountDb()

  const accountDir = resolve(config.dataDir, phone)
  mkdirSync(accountDir, { recursive: true })
  const targetPath = resolve(accountDir, 'account.db')

  for (const ext of ['', '-wal', '-shm']) {
    try { unlinkSync(targetPath + ext) } catch { /* ignore */ }
  }
  copyFileSync(srcPath, targetPath)

  if (wasCurrentPhone) initAccountDb(phone)
}

export function closeAccountDb() {
  if (db) {
    try {
      accountSqlite?.close()
    } catch {
      // ignore close errors
    }
    db = null
    accountSqlite = null
    logger.info({ phone: currentPhone }, 'Account database closed')
    currentPhone = null
  }
}
