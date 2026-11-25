import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedTenant } from '../helpers/fixtures.js'
import { getAccountDb } from '../../src/db/account.js'
import { botTriggers, tenantGroups } from '../../src/db/schema.js'
import {
  TenantConflictError, listTenants, getTenant, createTenant, renameTenant, deleteTenant,
  getTenantEntries, setTenantGroups, getTenantIdForGroup, getTenantCoveredGroupJids,
} from '../../src/db/queries/tenants.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => {
  dbs = setupTestDbs()
  seedGroup('comm@g.us', 'Community', { isCommunity: true })
  seedGroup('c1@g.us', 'Child 1', { parentCommunityJid: 'comm@g.us' })
  seedGroup('c2@g.us', 'Child 2', { parentCommunityJid: 'comm@g.us' })
  seedGroup('s1@g.us', 'Single')
})
afterEach(() => { dbs.cleanup() })

describe('tenant queries', () => {
  it('creates, renames, lists by name and deletes a tenant with its rows', () => {
    const b = createTenant('Beta')
    const a = seedTenant('Alpha', ['s1@g.us'])
    expect(listTenants().map(t => t.name)).toEqual(['Alpha', 'Beta'])
    renameTenant(b, 'Zeta')
    expect(getTenant(b)?.name).toBe('Zeta')
    expect(listTenants().map(t => t.name)).toEqual(['Alpha', 'Zeta'])
    expect(getTenant(999)).toBeNull()

    getAccountDb().insert(botTriggers).values({ tenantId: a, type: 'x', name: 't', sortOrder: 1 }).run()
    deleteTenant(a)
    expect(getTenant(a)).toBeNull()
    expect(getAccountDb().select().from(tenantGroups).all()).toEqual([])
    expect(getAccountDb().select().from(botTriggers).all()).toEqual([])
    expect(getTenant(b)).not.toBeNull()
  })

  it('replaces entries on setTenantGroups', () => {
    const a = seedTenant('A', ['comm@g.us'])
    setTenantGroups(a, ['s1@g.us', 's1@g.us'])
    expect(getTenantEntries(a)).toEqual(['s1@g.us'])
  })

  it('refuses groups that would be in two tenants', () => {
    seedTenant('A', ['comm@g.us'])
    const b = createTenant('B')
    expect(() => setTenantGroups(b, ['c1@g.us'])).toThrow(TenantConflictError)
    try { setTenantGroups(b, ['c1@g.us']) } catch (e) {
      expect((e as TenantConflictError).conflicts).toEqual(['c1@g.us'])
    }
    expect(getTenantEntries(b)).toEqual([])
  })

  it('refuses unknown group jids', () => {
    const a = createTenant('A')
    expect(() => setTenantGroups(a, ['nope@g.us'])).toThrow('Unknown group jids: nope@g.us')
  })

  it('getTenantIdForGroup / getTenantCoveredGroupJids follow the rules', () => {
    const a = seedTenant('A', ['comm@g.us'])
    const b = seedTenant('B', [])
    expect(getTenantIdForGroup('c2@g.us')).toBe(a)
    expect(getTenantIdForGroup('s1@g.us')).toBeNull()
    expect(getTenantCoveredGroupJids(a).sort()).toEqual(['c1@g.us', 'c2@g.us'])
    expect(getTenantCoveredGroupJids(b)).toEqual([])
  })
})
