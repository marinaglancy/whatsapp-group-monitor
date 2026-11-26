import { and, desc, eq, gte } from 'drizzle-orm'
import { getAccountDb } from '../account.js'
import { spamCases, type SpamCase, type SpamCaseState, type SpamVerdict } from '../schema.js'

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
}

/** A stored report state with every list present: rows saved before the
 *  removal lists existed have only notDeleted and deleted. */
export function fullCaseState(raw: unknown): SpamCaseState {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const state: SpamCaseState = {
    notDeleted: strings(s.notDeleted),
    deleted: strings(s.deleted),
    removedFrom: strings(s.removedFrom),
    notRemovedFrom: strings(s.notRemovedFrom),
  }
  if (s.community === 'removed' || s.community === 'not_removed') state.community = s.community
  if (typeof s.communityJid === 'string') state.communityJid = s.communityJid
  return state
}

function withFullState(c: SpamCase | undefined): SpamCase | null {
  if (!c) return null
  return { ...c, state: c.state ? fullCaseState(c.state) : null }
}

export function getCase(id: number): SpamCase | null {
  return withFullState(getAccountDb().select().from(spamCases).where(eq(spamCases.id, id)).get())
}

/** The newest case for this trigger, user and text created at or after sinceMs. */
export function findRecentCase(triggerId: number, userJid: string, textKey: string, sinceMs: number): SpamCase | null {
  return withFullState(getAccountDb().select().from(spamCases)
    .where(and(
      eq(spamCases.triggerId, triggerId),
      eq(spamCases.userJid, userJid),
      eq(spamCases.textKey, textKey),
      gte(spamCases.createdAt, sinceMs),
    ))
    .orderBy(desc(spamCases.createdAt), desc(spamCases.id))
    .limit(1)
    .get())
}

export function createCase(p: {
  triggerId: number; userJid: string; textKey: string; verdict: SpamVerdict; now?: number
}): number {
  const now = p.now ?? Date.now()
  return getAccountDb().insert(spamCases).values({
    triggerId: p.triggerId, userJid: p.userJid, textKey: p.textKey, verdict: p.verdict,
    createdAt: now, updatedAt: now,
  }).returning({ id: spamCases.id }).get().id
}

export function updateCaseReport(id: number, p: {
  reportGroupJid?: string; reportMessageId: string; reportPostedAt: number; state: SpamCaseState
}): void {
  getAccountDb().update(spamCases).set({
    ...(p.reportGroupJid !== undefined ? { reportGroupJid: p.reportGroupJid } : {}),
    reportMessageId: p.reportMessageId,
    reportPostedAt: p.reportPostedAt,
    state: p.state,
    updatedAt: Date.now(),
  }).where(eq(spamCases.id, id)).run()
}
