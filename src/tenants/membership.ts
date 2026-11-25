export interface GroupNode { jid: string; parentCommunityJid: string | null; isCommunity: boolean }
export type EntryMap = Map<string, number> // tenant_groups: jid -> tenantId
export type GroupMap = Map<string, GroupNode>

/** The group's own entry wins, else its parent community's entry. */
export function tenantOfGroup(groupJid: string, entries: EntryMap, groups: GroupMap): number | null {
  const own = entries.get(groupJid)
  if (own !== undefined) return own
  const parent = groups.get(groupJid)?.parentCommunityJid
  if (parent) return entries.get(parent) ?? null
  return null
}

/** Non-community groups that belong to the tenant, directly or through a community. */
export function coveredGroupJids(tenantId: number, entries: EntryMap, groups: GroupMap): string[] {
  const result: string[] = []
  for (const g of groups.values()) {
    if (!g.isCommunity && tenantOfGroup(g.jid, entries, groups) === tenantId) result.push(g.jid)
  }
  return result
}

/** Group jids that would end up in two tenants if the tenant's entries became newJids.
 *  The tenant's own current entries are ignored; tenantId null means a tenant that does not exist yet. */
export function findConflicts(tenantId: number | null, newJids: string[], entries: EntryMap, groups: GroupMap): string[] {
  const isOther = (jid: string) => {
    const owner = entries.get(jid)
    return owner !== undefined && owner !== tenantId
  }
  const conflicts = new Set<string>()
  for (const jid of newJids) {
    if (isOther(jid)) conflicts.add(jid)
    const parent = groups.get(jid)?.parentCommunityJid
    if (parent && isOther(parent)) conflicts.add(jid)
    if (groups.get(jid)?.isCommunity) {
      for (const g of groups.values()) {
        if (g.parentCommunityJid === jid && isOther(g.jid)) conflicts.add(g.jid)
      }
    }
  }
  return [...conflicts]
}

/** Children of the tenant's communities that are directly entered for another tenant. */
export function shadowedGroups(tenantId: number, entries: EntryMap, groups: GroupMap): string[] {
  const result: string[] = []
  for (const g of groups.values()) {
    if (!g.parentCommunityJid || entries.get(g.parentCommunityJid) !== tenantId) continue
    const own = entries.get(g.jid)
    if (own !== undefined && own !== tenantId) result.push(g.jid)
  }
  return result
}

/** Another tenant's claim on a group, seen from tenantId: that tenant's own entry for the group,
 *  else its entry for the group's community (communityJid set). null when no other tenant claims it. */
export function otherTenantClaim(
  groupJid: string, tenantId: number, entries: EntryMap, groups: GroupMap,
): { tenantId: number; communityJid: string | null } | null {
  const own = entries.get(groupJid)
  if (own !== undefined && own !== tenantId) return { tenantId: own, communityJid: null }
  const parent = groups.get(groupJid)?.parentCommunityJid
  const viaParent = parent ? entries.get(parent) : undefined
  if (parent && viaParent !== undefined && viaParent !== tenantId) return { tenantId: viaParent, communityJid: parent }
  return null
}
