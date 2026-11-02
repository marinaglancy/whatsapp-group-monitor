import { eq, and, desc, sql, gte, inArray } from 'drizzle-orm'
import { getAccountDb } from '../account.js'
import { groupActivityLog } from '../schema.js'
import type { ActivityRecord } from '../../whatsapp/activity/record.js'

/** Insert activity record. Returns true if inserted, false if duplicate. */
export function insertActivity(record: ActivityRecord): boolean {
  const db = getAccountDb()
  try {
    db.insert(groupActivityLog).values({
      groupJid: record.groupJid,
      userJid: record.userJid,
      messageId: record.messageId,
      parentId: record.parentId,
      eventType: record.eventType,
      metadata: record.metadata,
      raw: record.raw,
      timestamp: record.timestamp,
      createdAt: new Date(),
    }).run()
    return true
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') return false
    throw err
  }
}

/** Get a creation record (poll_create or event_create) by message ID */
export function getCreationRecord(groupJid: string, messageId: string) {
  const db = getAccountDb()
  return db.select()
    .from(groupActivityLog)
    .where(and(
      eq(groupActivityLog.groupJid, groupJid),
      eq(groupActivityLog.messageId, messageId),
    ))
    .get()
}

/** Count activity events per group since a given timestamp */
export function getGroupActivityCounts(groupJids: string[], sinceTimestamp: number): Map<string, number> {
  const result = new Map<string, number>()
  if (groupJids.length === 0) return result
  const db = getAccountDb()
  const rows = db.select({
    groupJid: groupActivityLog.groupJid,
    cnt: sql<number>`count(*)`.as('cnt'),
  })
    .from(groupActivityLog)
    .where(and(
      inArray(groupActivityLog.groupJid, groupJids),
      gte(groupActivityLog.timestamp, sinceTimestamp),
    ))
    .groupBy(groupActivityLog.groupJid)
    .all()
  for (const row of rows) result.set(row.groupJid, row.cnt)
  return result
}

/** Get most recent activity timestamp per group */
export function getGroupLastActivity(groupJids: string[]): Map<string, number> {
  const result = new Map<string, number>()
  if (groupJids.length === 0) return result
  const db = getAccountDb()
  const rows = db.select({
    groupJid: groupActivityLog.groupJid,
    lastTs: sql<number>`max(timestamp)`.as('last_ts'),
  })
    .from(groupActivityLog)
    .where(inArray(groupActivityLog.groupJid, groupJids))
    .groupBy(groupActivityLog.groupJid)
    .all()
  for (const row of rows) {
    if (row.lastTs) result.set(row.groupJid, row.lastTs)
  }
  return result
}

/** Oldest activity timestamp in a group, or null when nothing is recorded */
export function getGroupFirstActivity(groupJid: string): number | null {
  const db = getAccountDb()
  const row = db.select({ firstTs: sql<number | null>`min(timestamp)` })
    .from(groupActivityLog)
    .where(eq(groupActivityLog.groupJid, groupJid))
    .get()
  return row?.firstTs ?? null
}

/** Whether a reaction by this person to this message is recorded at or after the given time */
export function hasReactionSince(groupJid: string, targetMsgId: string, userJid: string, since: number): boolean {
  const db = getAccountDb()
  const row = db.select({ id: groupActivityLog.id })
    .from(groupActivityLog)
    .where(and(
      eq(groupActivityLog.groupJid, groupJid),
      eq(groupActivityLog.parentId, targetMsgId),
      eq(groupActivityLog.userJid, userJid),
      eq(groupActivityLog.eventType, 'reaction'),
      gte(groupActivityLog.timestamp, since),
    ))
    .get()
  return row !== undefined
}

/** Per-group activity breakdown for a user in the last N days */
export function getUserActivityPerGroup(userJid: string, sinceDays: number) {
  const db = getAccountDb()
  const sinceTs = Math.floor(Date.now() / 1000) - (sinceDays * 86400)
  return db.select({
    groupJid: groupActivityLog.groupJid,
    total: sql<number>`count(*)`.as('total'),
    posts: sql<number>`sum(case when event_type in ('message', 'poll_create', 'event_create') then 1 else 0 end)`.as('posts'),
    reactions: sql<number>`sum(case when event_type in ('reaction', 'poll_vote', 'event_response') then 1 else 0 end)`.as('reactions'),
    lastActivity: sql<number>`max(timestamp)`.as('last_activity'),
  })
    .from(groupActivityLog)
    .where(and(
      eq(groupActivityLog.userJid, userJid),
      gte(groupActivityLog.timestamp, sinceTs),
    ))
    .groupBy(groupActivityLog.groupJid)
    .all()
}

/** Per-user activity breakdown for a group in the last N days */
export function getGroupUserActivity(groupJid: string, sinceDays: number) {
  const db = getAccountDb()
  const sinceTs = Math.floor(Date.now() / 1000) - (sinceDays * 86400)
  return db.select({
    userJid: groupActivityLog.userJid,
    total: sql<number>`count(*)`.as('total'),
    posts: sql<number>`sum(case when event_type in ('message', 'poll_create', 'event_create') then 1 else 0 end)`.as('posts'),
    reactions: sql<number>`sum(case when event_type in ('reaction', 'poll_vote', 'event_response') then 1 else 0 end)`.as('reactions'),
    lastActivity: sql<number>`max(timestamp)`.as('last_activity'),
  })
    .from(groupActivityLog)
    .where(and(
      eq(groupActivityLog.groupJid, groupJid),
      gte(groupActivityLog.timestamp, sinceTs),
    ))
    .groupBy(groupActivityLog.userJid)
    .orderBy(desc(sql`total`))
    .all()
}
