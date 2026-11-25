import { eq, asc } from 'drizzle-orm'
import { getAccountDb } from '../account.js'
import { groups, tenants, tenantGroups, botTriggers, type Tenant } from '../schema.js'
import {
  tenantOfGroup, coveredGroupJids, findConflicts,
  type EntryMap, type GroupMap,
} from '../../tenants/membership.js'

export class TenantConflictError extends Error {
  constructor(public conflicts: string[]) {
    super(`Groups already belong to another tenant: ${conflicts.join(', ')}`)
    this.name = 'TenantConflictError'
  }
}

export function loadMembershipSnapshot(): { entries: EntryMap; groups: GroupMap } {
  const db = getAccountDb()
  const entries: EntryMap = new Map(db.select().from(tenantGroups).all().map(r => [r.jid, r.tenantId]))
  const groupMap: GroupMap = new Map(
    db.select({ jid: groups.jid, parentCommunityJid: groups.parentCommunityJid, isCommunity: groups.isCommunity })
      .from(groups).all().map(g => [g.jid, g]),
  )
  return { entries, groups: groupMap }
}

export function listTenants(): Tenant[] {
  return getAccountDb().select().from(tenants).orderBy(asc(tenants.name)).all()
}

export function getTenant(id: number): Tenant | null {
  return getAccountDb().select().from(tenants).where(eq(tenants.id, id)).get() ?? null
}

export function createTenant(name: string): number {
  return getAccountDb().insert(tenants).values({ name }).returning({ id: tenants.id }).get().id
}

export function renameTenant(id: number, name: string): void {
  getAccountDb().update(tenants).set({ name, updatedAt: new Date() }).where(eq(tenants.id, id)).run()
}

export function deleteTenant(id: number): void {
  const db = getAccountDb()
  db.transaction(tx => {
    tx.delete(tenantGroups).where(eq(tenantGroups.tenantId, id)).run()
    tx.delete(botTriggers).where(eq(botTriggers.tenantId, id)).run()
    tx.delete(tenants).where(eq(tenants.id, id)).run()
  })
}

export function getTenantEntries(tenantId: number): string[] {
  return getAccountDb().select({ jid: tenantGroups.jid }).from(tenantGroups)
    .where(eq(tenantGroups.tenantId, tenantId)).all().map(r => r.jid)
}

/** Replaces the tenant's entries. Throws TenantConflictError if a group would be in two tenants. */
export function setTenantGroups(tenantId: number, jids: string[]): void {
  const unique = [...new Set(jids)]
  const snapshot = loadMembershipSnapshot()
  const unknown = unique.filter(j => !snapshot.groups.has(j))
  if (unknown.length > 0) throw new Error(`Unknown group jids: ${unknown.join(', ')}`)
  const conflicts = findConflicts(tenantId, unique, snapshot.entries, snapshot.groups)
  if (conflicts.length > 0) throw new TenantConflictError(conflicts)

  getAccountDb().transaction(tx => {
    tx.delete(tenantGroups).where(eq(tenantGroups.tenantId, tenantId)).run()
    if (unique.length > 0) tx.insert(tenantGroups).values(unique.map(jid => ({ jid, tenantId }))).run()
  })
}

export function getTenantIdForGroup(groupJid: string): number | null {
  const { entries, groups: groupMap } = loadMembershipSnapshot()
  return tenantOfGroup(groupJid, entries, groupMap)
}

export function getTenantCoveredGroupJids(tenantId: number): string[] {
  const { entries, groups: groupMap } = loadMembershipSnapshot()
  return coveredGroupJids(tenantId, entries, groupMap)
}
