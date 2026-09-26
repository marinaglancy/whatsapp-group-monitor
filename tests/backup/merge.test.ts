import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { setupTestDbs, TEST_PHONE } from '../helpers/db.js'
import { seedGroup } from '../helpers/fixtures.js'
import { getGroup } from '../../src/db/queries/groups.js'
import { mergeAccountDb } from '../../src/web/routes/backup.js'

// groups schema as it was BEFORE the bot_config upgrade (real pre-upgrade backups)
const OLD_GROUPS_DDL = `CREATE TABLE groups (
  jid TEXT PRIMARY KEY, name TEXT NOT NULL, is_community INTEGER NOT NULL DEFAULT 0,
  parent_community_jid TEXT, permissions TEXT, bot_membership TEXT NOT NULL DEFAULT 'none',
  bot_functions INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`

const NEW_GROUPS_DDL = OLD_GROUPS_DDL.replace(
  'created_at INTEGER NOT NULL)',
  'created_at INTEGER NOT NULL, bot_config TEXT)',
)

// the other tables the merge touches, current shape
const SUPPORT_DDL = `
CREATE TABLE users (jid TEXT PRIMARY KEY, phone_number TEXT, is_banned INTEGER NOT NULL DEFAULT 0,
  display_name TEXT, display_name_updated_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE group_members (group_jid TEXT NOT NULL, user_jid TEXT NOT NULL, membership TEXT NOT NULL DEFAULT 'participant',
  joined_at INTEGER, left_at INTEGER, updated_at INTEGER NOT NULL, last_read_at TEXT, PRIMARY KEY (group_jid, user_jid));
CREATE TABLE group_activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, group_jid TEXT NOT NULL, user_jid TEXT NOT NULL,
  message_id TEXT NOT NULL, parent_id TEXT, event_type TEXT NOT NULL, metadata TEXT, raw TEXT, timestamp INTEGER NOT NULL, created_at INTEGER NOT NULL);
`

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs() })
afterEach(() => { dbs.cleanup() })

function makeBackupDb(path: string, groupsDdl: string, inserts: string): void {
  const db = new Database(path)
  db.exec(groupsDdl)
  db.exec(SUPPORT_DDL)
  db.exec(inserts)
  db.close()
}

describe('mergeAccountDb groups schema drift', () => {
  it('merges a pre-upgrade backup (no bot_config column) into a migrated live db', () => {
    const backupPath = join(dbs.dir, 'old-backup.db')
    makeBackupDb(backupPath, OLD_GROUPS_DDL, `
      INSERT INTO groups (jid, name, is_community, bot_membership, bot_functions, is_archived, created_at)
      VALUES ('legacy@g.us', 'Legacy Group', 0, 'participant', 0, 0, 1700000000000)`)
    mergeAccountDb(TEST_PHONE, backupPath)
    const g = getGroup('legacy@g.us')!
    expect(g).not.toBeNull()
    expect(g.name).toBe('Legacy Group')
    expect(g.isArchived).toBe(false)
    expect(g.botConfig).toBeNull()
    expect(g.createdAt!.getTime()).toBe(1700000000000)
  })

  it('keeps live rows and carries bot_config from a current-schema backup', () => {
    seedGroup('mine@g.us', 'Mine')
    const backupPath = join(dbs.dir, 'new-backup.db')
    makeBackupDb(backupPath, NEW_GROUPS_DDL, `
      INSERT INTO groups (jid, name, is_community, bot_membership, bot_functions, is_archived, created_at, bot_config)
      VALUES ('mine@g.us', 'Renamed In Backup', 0, 'participant', 0, 0, 1700000000000, NULL),
             ('cfg@g.us', 'Configured', 0, 'participant', 1, 0, 1700000000000, '{"qa":{"linkedJids":["mine@g.us"],"instructions":"Hi"}}')`)
    mergeAccountDb(TEST_PHONE, backupPath)
    expect(getGroup('mine@g.us')!.name).toBe('Mine') // OR IGNORE keeps the live row
    const cfg = getGroup('cfg@g.us')!
    expect(cfg.qaEnabled).toBe(true)
    expect(cfg.qaLinkedJids).toEqual(['mine@g.us'])
    expect(cfg.qaInstructions).toBe('Hi')
  })
})
