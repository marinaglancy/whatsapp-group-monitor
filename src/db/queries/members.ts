import { eq, and, notInArray, sql, inArray, or, isNull, lt } from 'drizzle-orm'
import type { GroupParticipant } from 'baileys'
import { getAccountDb } from '../account.js'
import { groupMembers, users, groups, groupActivityLog, type MembershipLevel } from '../schema.js'
import { upsertUser } from './users.js'

export interface MembershipEventOpts {
  /** Who performed the action, when known (live participant updates carry it). */
  actor?: string | null
  /** 'event' = live/replayed WhatsApp event, 'sync' = detected by a full sync diff. */
  source?: 'event' | 'sync'
  /** Baseline syncs of a previously unknown group suppress join events. */
  suppressEvents?: boolean
}

function isActiveMembership(m: MembershipLevel | undefined | null): boolean {
  return !!m && m !== 'none' && m !== 'pending_approval'
}

/** Record a member_joined / member_left row in the activity log (feeds
 *  activity_stats joined/left; actor kept for future admin analysis). */
function recordMembershipEvent(
  groupJid: string,
  userJid: string,
  eventType: 'member_joined' | 'member_left',
  opts: MembershipEventOpts,
): void {
  const db = getAccountDb()
  const bare = userJid.split(':')[0].split('@')[0]
  const prefix = eventType === 'member_joined' ? 'mj' : 'ml'
  const messageId = `${prefix}_${bare}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  db.insert(groupActivityLog).values({
    groupJid,
    userJid,
    messageId,
    parentId: null,
    eventType,
    metadata: { source: opts.source ?? 'sync', ...(opts.actor ? { actor: opts.actor } : {}) },
    raw: null,
    timestamp: Math.floor(Date.now() / 1000),
  }).run()
}

export function membershipFromAdmin(admin: GroupParticipant['admin']): MembershipLevel {
  if (admin === 'superadmin') return 'superadmin'
  if (admin === 'admin') return 'admin'
  return 'participant'
}

export function getUserGroupMemberships(userJid: string) {
  const db = getAccountDb()
  return db.select({
    groupJid: groupMembers.groupJid,
    groupName: groups.name,
    isCommunity: groups.isCommunity,
    parentCommunityJid: groups.parentCommunityJid,
    membership: groupMembers.membership,
    lastReadAt: groupMembers.lastReadAt,
    joinedAt: groupMembers.joinedAt,
    leftAt: groupMembers.leftAt,
  })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupJid, groups.jid))
    .where(eq(groupMembers.userJid, userJid))
    .all()
}

export function updateLastReadAt(groupJid: string, userJid: string, date: string) {
  const db = getAccountDb()
  db.update(groupMembers)
    .set({ lastReadAt: date })
    .where(and(
      eq(groupMembers.groupJid, groupJid),
      eq(groupMembers.userJid, userJid),
      or(isNull(groupMembers.lastReadAt), lt(groupMembers.lastReadAt, date)),
    ))
    .run()
}

export function upsertMembership(groupJid: string, userJid: string, membership: MembershipLevel, opts: MembershipEventOpts = {}) {
  const db = getAccountDb()
  const now = new Date()
  const isLeaving = membership === 'none'
  const isJoining = membership !== 'none' && membership !== 'pending_approval'

  const prev = db.select({ membership: groupMembers.membership })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupJid, groupJid), eq(groupMembers.userJid, userJid)))
    .get()
  const wasActive = isActiveMembership(prev?.membership)
  const isActive = isActiveMembership(membership)
  const becameActive = !wasActive && isActive
  const becameInactive = wasActive && !isActive
  if (!opts.suppressEvents) {
    if (becameActive) {
      recordMembershipEvent(groupJid, userJid, 'member_joined', opts)
    } else if (becameInactive) {
      recordMembershipEvent(groupJid, userJid, 'member_left', opts)
    }
  }

  return db.insert(groupMembers).values({
    groupJid,
    userJid,
    membership,
    // suppressEvents marks "we just learned about them" (baseline roster):
    // their real join date is unknown, so it stays empty — never fabricated.
    joinedAt: isJoining && !opts.suppressEvents ? now : null,
    leftAt: isLeaving ? now : null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [groupMembers.groupJid, groupMembers.userJid],
    set: {
      membership,
      // joined_at/left_at record TRANSITIONS: a resync of an unchanged member
      // must not move them (the model reads joined_at via group_members)
      ...(becameInactive ? { leftAt: now } : {}),
      ...(becameActive ? { joinedAt: now, leftAt: null } : {}),
      updatedAt: now,
    },
  }).run()
}

export function syncGroupParticipants(groupJid: string, participants: GroupParticipant[]) {
  const db = getAccountDb()
  const activeUserJids: string[] = []

  db.transaction(() => {
    // Baseline: a group with no known members yet gets its initial roster
    // without join events (they didn't join now, we just learned about them).
    const baseline = !db.select({ userJid: groupMembers.userJid })
      .from(groupMembers)
      .where(eq(groupMembers.groupJid, groupJid))
      .limit(1)
      .get()

    for (const p of participants) {
      upsertUser(p.id, {
        phoneNumber: p.phoneNumber || undefined,
        displayName: p.notify || undefined,
      })
      const membership = membershipFromAdmin(p.admin)
      upsertMembership(groupJid, p.id, membership, { source: 'sync', suppressEvents: baseline })
      activeUserJids.push(p.id)
    }

    // Members no longer in the roster: mark left one by one so the
    // membership event is emitted per member.
    const missing = db.select({ userJid: groupMembers.userJid })
      .from(groupMembers)
      .where(and(
        eq(groupMembers.groupJid, groupJid),
        notInArray(groupMembers.membership, ['none']),
        ...(activeUserJids.length ? [notInArray(groupMembers.userJid, activeUserJids)] : []),
      ))
      .all()
    for (const m of missing) {
      upsertMembership(groupJid, m.userJid, 'none', { source: 'sync', suppressEvents: baseline })
    }
  })
}

export function getGroupMembers(groupJid: string, opts?: { includeLeft?: boolean }) {
  const db = getAccountDb()
  const conditions = [eq(groupMembers.groupJid, groupJid)]
  if (!opts?.includeLeft) {
    conditions.push(notInArray(groupMembers.membership, ['none']))
  }
  return db.select({
    userJid: groupMembers.userJid,
    membership: groupMembers.membership,
    joinedAt: groupMembers.joinedAt,
    leftAt: groupMembers.leftAt,
    lastReadAt: groupMembers.lastReadAt,
    displayName: users.displayName,
    phoneNumber: users.phoneNumber,
    isBanned: users.isBanned,
  })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userJid, users.jid))
    .where(and(...conditions))
    .all()
}

/** Count distinct active members across multiple groups (for communities) */
export function getDistinctMemberCount(groupJids: string[]): number {
  if (groupJids.length === 0) return 0
  const db = getAccountDb()
  const row = db.select({
    cnt: sql<number>`count(distinct ${groupMembers.userJid})`.as('cnt'),
  })
    .from(groupMembers)
    .where(and(
      inArray(groupMembers.groupJid, groupJids),
      notInArray(groupMembers.membership, ['none']),
    ))
    .get()
  return row?.cnt ?? 0
}

/** Get distinct members across multiple groups with highest membership level */
export function getDistinctMembers(groupJids: string[], opts?: { includeLeft?: boolean }) {
  if (groupJids.length === 0) return []
  const db = getAccountDb()
  const conditions = [inArray(groupMembers.groupJid, groupJids)]
  if (!opts?.includeLeft) {
    conditions.push(notInArray(groupMembers.membership, ['none']))
  }
  return db.select({
    userJid: groupMembers.userJid,
    membership: sql<string>`case max(
      case when ${groupMembers.membership} = 'superadmin' then 5
      when ${groupMembers.membership} = 'admin' then 4
      when ${groupMembers.membership} = 'participant' then 3
      when ${groupMembers.membership} = 'pending_approval' then 2
      when ${groupMembers.membership} = 'none' then 1
      else 0 end)
      when 5 then 'superadmin'
      when 4 then 'admin'
      when 3 then 'participant'
      when 2 then 'pending_approval'
      when 1 then 'none'
      else 'participant' end`.as('membership'),
    joinedAt: sql<Date | null>`min(${groupMembers.joinedAt})`.as('joined_at'),
    leftAt: sql<Date | null>`max(${groupMembers.leftAt})`.as('left_at'),
    lastReadAt: sql<string | null>`max(${groupMembers.lastReadAt})`.as('last_read_at'),
    displayName: users.displayName,
    phoneNumber: users.phoneNumber,
    isBanned: users.isBanned,
  })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userJid, users.jid))
    .where(and(...conditions))
    .groupBy(groupMembers.userJid)
    .all()
}

export function getGroupMemberCounts(groupJids: string[]): Map<string, number> {
  const result = new Map<string, number>()
  if (groupJids.length === 0) return result

  const db = getAccountDb()
  const rows = db.select({
    groupJid: groupMembers.groupJid,
    cnt: sql<number>`count(*)`.as('cnt'),
  })
    .from(groupMembers)
    .where(and(
      inArray(groupMembers.groupJid, groupJids),
      notInArray(groupMembers.membership, ['none']),
    ))
    .groupBy(groupMembers.groupJid)
    .all()

  for (const row of rows) {
    result.set(row.groupJid, row.cnt)
  }
  return result
}
