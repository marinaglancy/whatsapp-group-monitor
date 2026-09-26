import { BOT_FUNCTION_QA, type Group, type GroupBotConfig } from '../../db/schema.js'
import { getGroupMemberCounts, getGroupMembers, getDistinctMemberCount, getDistinctMembers } from '../../db/queries/members.js'
import { getGroupActivityCounts, getGroupLastActivity, getGroupUserActivity } from '../../db/queries/activity.js'

export class GroupRecord {
  jid: string
  name: string
  isCommunity: boolean
  parentCommunityJid: string | null
  permissions: Group['permissions']
  botMembership: Group['botMembership']
  botFunctions: number
  botConfig: GroupBotConfig | null
  description: string | null
  isArchived: boolean
  createdAt: Date | null

  // Summary properties — populated by populateAllSummaries()
  memberCount: number = 0
  activityCount: number = 0
  lastActivity: number | null = null

  private _parent: GroupRecord | null = null
  private _children: GroupRecord[] = []

  constructor(row: Group) {
    this.jid = row.jid
    this.name = row.name
    this.isCommunity = row.isCommunity ?? false
    this.parentCommunityJid = row.parentCommunityJid
    this.permissions = row.permissions
    this.botMembership = row.botMembership
    this.botFunctions = row.botFunctions
    this.botConfig = row.botConfig ?? null
    this.description = row.description ?? null
    this.isArchived = row.isArchived ?? false
    this.createdAt = row.createdAt
  }

  static fromDbRow(row: Group): GroupRecord {
    return new GroupRecord(row)
  }

  /** Populate parent/children references across all groups */
  static linkAll(groups: GroupRecord[]): void {
    for (const g of groups) {
      g._parent = null
      g._children = []
    }
    const byJid = new Map(groups.map(g => [g.jid, g]))
    for (const g of groups) {
      if (g.parentCommunityJid) {
        const parent = byJid.get(g.parentCommunityJid)
        if (parent) {
          g._parent = parent
          parent._children.push(g)
        }
      }
    }
  }

  /** Populate memberCount, activityCount, lastActivity for all groups in one batch */
  static populateAllSummaries(groups: GroupRecord[]): void {
    const nonCommunityJids = groups.filter(g => !g.isCommunity).map(g => g.jid)
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 86400)

    const memberCounts = getGroupMemberCounts(nonCommunityJids)
    const activityCounts = getGroupActivityCounts(nonCommunityJids, thirtyDaysAgo)
    const lastActivityMap = getGroupLastActivity(nonCommunityJids)

    // Populate regular groups
    for (const g of groups) {
      if (g.isCommunity) continue
      g.memberCount = memberCounts.get(g.jid) ?? 0
      g.activityCount = activityCounts.get(g.jid) ?? 0
      g.lastActivity = lastActivityMap.get(g.jid) ?? null
    }

    // Populate communities from children
    for (const g of groups) {
      if (!g.isCommunity) continue
      const childJids = g.getChildJids()
      g.memberCount = childJids.length > 0 ? getDistinctMemberCount(childJids) : 0
      g.activityCount = childJids.reduce((sum, jid) => sum + (activityCounts.get(jid) ?? 0), 0)
      const maxLast = childJids.reduce((max, jid) => {
        const ts = lastActivityMap.get(jid)
        return ts && ts > (max ?? 0) ? ts : max
      }, null as number | null)
      g.lastActivity = maxLast
    }
  }

  get qaEnabled(): boolean {
    return (this.botFunctions & BOT_FUNCTION_QA) !== 0
  }

  get qaLinkedJids(): string[] {
    return this.botConfig?.qa?.linkedJids ?? []
  }

  get qaInstructions(): string | null {
    return this.botConfig?.qa?.instructions ?? null
  }

  getParent(): GroupRecord | null {
    return this._parent
  }

  getChildren(): GroupRecord[] {
    return this._children
  }

  getChildJids(): string[] {
    return this._children.map(g => g.jid)
  }

  getMemberCount(): number {
    if (this.isCommunity) {
      const childJids = this.getChildJids()
      return childJids.length > 0 ? getDistinctMemberCount(childJids) : 0
    }
    const counts = getGroupMemberCounts([this.jid])
    return counts.get(this.jid) ?? 0
  }

  getMembers(opts?: { includeLeft?: boolean }) {
    if (this.isCommunity) {
      return getDistinctMembers(this.getChildJids(), opts)
    }
    return getGroupMembers(this.jid, opts)
  }

  getActivityCount(sinceTimestamp: number): number {
    if (this.isCommunity) {
      const childJids = this.getChildJids()
      const counts = getGroupActivityCounts(childJids, sinceTimestamp)
      let total = 0
      for (const cnt of counts.values()) total += cnt
      return total
    }
    const counts = getGroupActivityCounts([this.jid], sinceTimestamp)
    return counts.get(this.jid) ?? 0
  }

  getLastActivity(): number | null {
    if (this.isCommunity) {
      const childJids = this.getChildJids()
      const map = getGroupLastActivity(childJids)
      let max: number | null = null
      for (const ts of map.values()) {
        if (max === null || ts > max) max = ts
      }
      return max
    }
    const map = getGroupLastActivity([this.jid])
    return map.get(this.jid) ?? null
  }

  getUserActivity(sinceDays: number) {
    if (this.isCommunity) {
      const merged = new Map<string, { userJid: string; total: number; posts: number; reactions: number; lastActivity: number | null }>()
      for (const childJid of this.getChildJids()) {
        for (const a of getGroupUserActivity(childJid, sinceDays)) {
          const existing = merged.get(a.userJid)
          if (existing) {
            existing.total += a.total
            existing.posts += a.posts
            existing.reactions += a.reactions
            existing.lastActivity = Math.max(existing.lastActivity ?? 0, a.lastActivity ?? 0) || null
          } else {
            merged.set(a.userJid, { ...a })
          }
        }
      }
      return Array.from(merged.values()).sort((a, b) => b.total - a.total)
    }
    return getGroupUserActivity(this.jid, sinceDays)
  }

  toJSON() {
    return {
      jid: this.jid,
      name: this.name,
      isCommunity: this.isCommunity,
      parentCommunityJid: this.parentCommunityJid,
      permissions: this.permissions,
      botMembership: this.botMembership,
      botFunctions: this.botFunctions,
      qaEnabled: this.qaEnabled,
      qaLinkedJids: this.qaLinkedJids,
      qaInstructions: this.qaInstructions,
      description: this.description,
      isArchived: this.isArchived,
      memberCount: this.memberCount,
      activityCount: this.activityCount,
      lastActivity: this.lastActivity,
    }
  }
}
