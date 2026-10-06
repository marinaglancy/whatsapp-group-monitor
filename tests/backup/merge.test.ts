import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { setupTestDbs, TEST_PHONE } from '../helpers/db.js'
import { seedGroup } from '../helpers/fixtures.js'
import { getGroup } from '../../src/db/queries/groups.js'
import { mergeAccountDb } from '../../src/web/routes/backup.js'
import { makeBackupDb, OLD_GROUPS_DDL, NEW_GROUPS_DDL } from '../helpers/backup.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs() })
afterEach(() => { dbs.cleanup() })

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
