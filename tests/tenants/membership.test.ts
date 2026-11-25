import { describe, it, expect } from 'vitest'
import {
  tenantOfGroup, coveredGroupJids, findConflicts, shadowedGroups, otherTenantClaim,
  type EntryMap, type GroupMap, type GroupNode,
} from '../../src/tenants/membership.js'

const A = 1
const B = 2

function node(jid: string, parent: string | null = null, isCommunity = false): [string, GroupNode] {
  return [jid, { jid, parentCommunityJid: parent, isCommunity }]
}

function makeGroups(): GroupMap {
  return new Map([
    node('comm', null, true),
    node('c1', 'comm'),
    node('c2', 'comm'),
    node('s1'),
  ])
}

describe('tenant membership rules', () => {
  it('resolves a group through its own entry first, then its community', () => {
    const groups = makeGroups()
    expect(tenantOfGroup('c1', new Map([['comm', A]]), groups)).toBe(A)
    expect(tenantOfGroup('c1', new Map([['comm', A], ['c1', B]]), groups)).toBe(B)
    expect(tenantOfGroup('s1', new Map([['comm', A]]), groups)).toBeNull()
  })

  it('covers current and future community groups', () => {
    const groups = makeGroups()
    const entries: EntryMap = new Map([['comm', A], ['s1', A]])
    expect(coveredGroupJids(A, entries, groups).sort()).toEqual(['c1', 'c2', 's1'])
    const [k, v] = node('c3', 'comm')
    groups.set(k, v)
    expect(coveredGroupJids(A, entries, groups)).toContain('c3')
  })

  it('reports a community child that is in another tenant', () => {
    expect(findConflicts(A, ['comm'], new Map([['c1', B]]), makeGroups())).toEqual(['c1'])
  })

  it('reports a single group whose community is in another tenant', () => {
    expect(findConflicts(A, ['c2'], new Map([['comm', B]]), makeGroups())).toEqual(['c2'])
  })

  it('reports a jid that is directly in another tenant', () => {
    expect(findConflicts(null, ['s1'], new Map([['s1', B]]), makeGroups())).toEqual(['s1'])
  })

  it('ignores the tenant\'s own current entries', () => {
    expect(findConflicts(A, ['comm', 's1'], new Map([['comm', A]]), makeGroups())).toEqual([])
  })

  it('lists shadowed groups for the tenant page warning', () => {
    expect(shadowedGroups(A, new Map([['comm', A], ['c1', B]]), makeGroups())).toEqual(['c1'])
  })

  it('names the other tenant that claims a group, directly or through its community', () => {
    const entries: EntryMap = new Map([['comm', B], ['c1', A], ['s1', B]])
    expect(otherTenantClaim('c1', A, entries, makeGroups())).toEqual({ tenantId: B, communityJid: 'comm' })
    expect(otherTenantClaim('c1', B, entries, makeGroups())).toEqual({ tenantId: A, communityJid: null })
    expect(otherTenantClaim('s1', A, entries, makeGroups())).toEqual({ tenantId: B, communityJid: null })
    expect(otherTenantClaim('c2', B, entries, makeGroups())).toBeNull()
    expect(otherTenantClaim('s1', B, entries, makeGroups())).toBeNull()
  })
})
