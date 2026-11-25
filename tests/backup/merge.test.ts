import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { setupTestDbs, TEST_PHONE } from '../helpers/db.js'
import { seedGroup } from '../helpers/fixtures.js'
import { getGroup } from '../../src/db/queries/groups.js'
import { mergeAccountDb } from '../../src/web/routes/backup.js'
import { makeBackupDb, OLD_GROUPS_DDL, NEW_GROUPS_DDL, TENANT_DDL } from '../helpers/backup.js'
import { seedTenant } from '../helpers/fixtures.js'
import { getAccountDb } from '../../src/db/account.js'
import { listTenants, getTenantEntries } from '../../src/db/queries/tenants.js'
import { listTriggers } from '../../src/db/queries/triggers.js'

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
    expect(cfg.botFunctions).toBe(1)
    expect(cfg.botConfig).toEqual({ qa: { linkedJids: ['mine@g.us'], instructions: 'Hi' } })
  })
})

const GROUP_INSERT = `INSERT INTO groups (jid, name, is_community, bot_membership, bot_functions, is_archived, created_at, bot_config) VALUES`

describe('mergeAccountDb tenants', () => {
  function tenantBackup(path: string): void {
    makeBackupDb(path, NEW_GROUPS_DDL + ';' + TENANT_DDL, `
      ${GROUP_INSERT} ('a@g.us', 'A', 0, 'participant', 0, 0, 1700000000000, NULL),
                      ('b@g.us', 'B', 0, 'participant', 0, 0, 1700000000000, NULL);
      INSERT INTO tenants VALUES (7, 'Backup tenant', 1, 1);
      INSERT INTO tenant_groups VALUES ('a@g.us', 7), ('b@g.us', 7);
      INSERT INTO bot_triggers VALUES (3, 7, 'qa', 'Questions', 1, 1, '{"qaGroupJid":"a@g.us"}', 1, 1);`)
  }

  it('copies backup tenants with their groups and triggers when none of their groups is taken', () => {
    const backupPath = join(dbs.dir, 'tenants.db')
    tenantBackup(backupPath)
    const result = mergeAccountDb(TEST_PHONE, backupPath)
    expect(result.skippedTenants).toEqual([])
    const [t] = listTenants()
    expect(t.name).toBe('Backup tenant')
    expect(getTenantEntries(t.id).sort()).toEqual(['a@g.us', 'b@g.us'])
    const triggers = listTriggers(t.id)
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({ type: 'qa', name: 'Questions', enabled: true, config: { qaGroupJid: 'a@g.us' } })
  })

  it('skips a backup tenant whose group is already in a live tenant and reports it', () => {
    seedGroup('a@g.us', 'A')
    const liveId = seedTenant('Live', ['a@g.us'])
    const backupPath = join(dbs.dir, 'tenants.db')
    tenantBackup(backupPath)
    const result = mergeAccountDb(TEST_PHONE, backupPath)
    expect(result.skippedTenants).toEqual([{ name: 'Backup tenant', conflicts: ['a@g.us'] }])
    expect(listTenants().map(t => t.id)).toEqual([liveId])
    expect(getTenantEntries(liveId)).toEqual(['a@g.us'])
  })

  it('turns an old backup\'s Q&A groups into tenants', () => {
    const backupPath = join(dbs.dir, 'old-qa.db')
    makeBackupDb(backupPath, NEW_GROUPS_DDL, `
      ${GROUP_INSERT} ('qa@g.us', 'Admins', 0, 'participant', 1, 0, 1700000000000, '{"qa":{"linkedJids":["x@g.us"],"instructions":"Be kind"}}')`)
    mergeAccountDb(TEST_PHONE, backupPath)
    const [t] = listTenants()
    expect(t.name).toBe('Admins')
    expect(getTenantEntries(t.id).sort()).toEqual(['qa@g.us', 'x@g.us'])
    expect(listTriggers(t.id)[0]).toMatchObject({ type: 'qa', config: { qaGroupJid: 'qa@g.us', instructions: 'Be kind' } })
  })

  it('first converts the live database\'s own Q&A groups when the new version never opened it', () => {
    seedGroup('live-qa@g.us', 'Live Q&A', { botFunctions: 1, botConfig: { qa: { linkedJids: [], instructions: 'Hi' } } })
    const raw = getAccountDb().$client
    raw.exec('DROP TABLE bot_triggers; DROP TABLE tenant_groups; DROP TABLE tenants')
    const backupPath = join(dbs.dir, 'old-qa.db')
    makeBackupDb(backupPath, OLD_GROUPS_DDL, `
      INSERT INTO groups (jid, name, is_community, bot_membership, bot_functions, is_archived, created_at)
      VALUES ('o@g.us', 'Old', 0, 'participant', 0, 0, 1700000000000)`)
    mergeAccountDb(TEST_PHONE, backupPath)
    const [t] = listTenants()
    expect(t.name).toBe('Live Q&A')
    expect(getTenantEntries(t.id)).toEqual(['live-qa@g.us'])
    expect(listTriggers(t.id)).toHaveLength(1)
  })
})
