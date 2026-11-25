import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import Database from 'better-sqlite3'
import { setupTestDbs, TEST_PHONE } from '../helpers/db.js'
import { seedGroup } from '../helpers/fixtures.js'
import { getGroup } from '../../src/db/queries/groups.js'
import { mergeAccountDb, skippedTenantText } from '../../src/web/routes/backup.js'
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
    expect(result.skippedTenants).toEqual([{ name: 'Backup tenant', conflicts: ['a@g.us'], alreadyHere: false }])
    expect(listTenants().map(t => t.id)).toEqual([liveId])
    expect(getTenantEntries(liveId)).toEqual(['a@g.us'])
  })

  it('reports a backup tenant as already here when a live tenant has the same name and the same groups', () => {
    seedGroup('a@g.us', 'A')
    seedGroup('b@g.us', 'B')
    seedTenant('Backup tenant', ['b@g.us', 'a@g.us'])
    const backupPath = join(dbs.dir, 'same.db')
    tenantBackup(backupPath)
    const result = mergeAccountDb(TEST_PHONE, backupPath)
    expect(result.skippedTenants).toEqual([{ name: 'Backup tenant', conflicts: expect.any(Array), alreadyHere: true }])
    expect(skippedTenantText(result.skippedTenants[0])).toBe('Tenant "Backup tenant" is already here')
  })

  it('does not call it already here when the groups differ or the name differs', () => {
    seedGroup('a@g.us', 'A')
    seedGroup('b@g.us', 'B')
    seedTenant('Backup tenant', ['a@g.us'])
    const backupPath = join(dbs.dir, 'differs.db')
    tenantBackup(backupPath)
    const result = mergeAccountDb(TEST_PHONE, backupPath)
    expect(result.skippedTenants[0].alreadyHere).toBe(false)
    expect(skippedTenantText(result.skippedTenants[0])).toBe(
      'Tenant "Backup tenant" from the backup was skipped because some of its groups already belong to another tenant')
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

  it('skips the second backup tenant when it shares a group with the first', () => {
    const backupPath = join(dbs.dir, 'shared.db')
    makeBackupDb(backupPath, NEW_GROUPS_DDL + ';' + TENANT_DDL, `
      ${GROUP_INSERT} ('a@g.us', 'A', 0, 'participant', 0, 0, 1700000000000, NULL),
                      ('b@g.us', 'B', 0, 'participant', 0, 0, 1700000000000, NULL);
      INSERT INTO tenants VALUES (1, 'First', 1, 1), (2, 'Second', 1, 1);
      INSERT INTO tenant_groups VALUES ('a@g.us', 1), ('b@g.us', 2);`)
    // make the second share a jid: tenant_groups.jid is unique, so use a community parent instead
    const raw = new Database(backupPath)
    raw.exec(`UPDATE groups SET is_community = 1 WHERE jid = 'a@g.us'; UPDATE groups SET parent_community_jid = 'a@g.us' WHERE jid = 'b@g.us'`)
    raw.close()
    const result = mergeAccountDb(TEST_PHONE, backupPath)
    expect(result.skippedTenants).toEqual([{ name: 'Second', conflicts: ['b@g.us'], alreadyHere: false }])
    expect(listTenants().map(t => t.name)).toEqual(['First'])
  })

  it('finds a conflict through a community that only the backup knows as the group\'s parent', () => {
    seedGroup('comm@g.us', 'Community', { isCommunity: true })
    seedTenant('Live', ['comm@g.us'])
    const backupPath = join(dbs.dir, 'child.db')
    makeBackupDb(backupPath, NEW_GROUPS_DDL + ';' + TENANT_DDL, `
      INSERT INTO groups (jid, name, is_community, parent_community_jid, bot_membership, bot_functions, is_archived, created_at, bot_config)
        VALUES ('child@g.us', 'Child', 0, 'comm@g.us', 'participant', 0, 0, 1700000000000, NULL);
      INSERT INTO tenants VALUES (1, 'Child tenant', 1, 1);
      INSERT INTO tenant_groups VALUES ('child@g.us', 1);`)
    const result = mergeAccountDb(TEST_PHONE, backupPath)
    expect(result.skippedTenants).toEqual([{ name: 'Child tenant', conflicts: ['child@g.us'], alreadyHere: false }])
    expect(listTenants().map(t => t.name)).toEqual(['Live'])
  })

  it('leaves nothing behind when a tenant fails halfway', () => {
    const backupPath = join(dbs.dir, 'broken.db')
    makeBackupDb(backupPath, NEW_GROUPS_DDL + ';' + TENANT_DDL.replace('name TEXT NOT NULL, enabled', 'name TEXT, enabled'), `
      ${GROUP_INSERT} ('a@g.us', 'A', 0, 'participant', 0, 0, 1700000000000, NULL);
      INSERT INTO tenants VALUES (1, 'Broken', 1, 1);
      INSERT INTO tenant_groups VALUES ('a@g.us', 1);
      INSERT INTO bot_triggers VALUES (1, 1, 'qa', NULL, 1, 1, '{}', 1, 1);`)
    expect(() => mergeAccountDb(TEST_PHONE, backupPath)).toThrow()
    expect(listTenants()).toEqual([])
    expect(getGroup('a@g.us')).toBeNull()
    const raw = getAccountDb().$client
    expect(raw.prepare('SELECT count(*) n FROM tenant_groups').get()).toEqual({ n: 0 })
    expect(raw.prepare('SELECT count(*) n FROM bot_triggers').get()).toEqual({ n: 0 })
  })
})
