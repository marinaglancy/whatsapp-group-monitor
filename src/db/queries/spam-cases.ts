import { and, desc, eq, gte } from 'drizzle-orm'
import { getAccountDb } from '../account.js'
import { spamCases, type SpamCase, type SpamCaseState, type SpamVerdict } from '../schema.js'

/** The newest case for this trigger, user and text created at or after sinceMs. */
export function findRecentCase(triggerId: number, userJid: string, textKey: string, sinceMs: number): SpamCase | null {
  return getAccountDb().select().from(spamCases)
    .where(and(
      eq(spamCases.triggerId, triggerId),
      eq(spamCases.userJid, userJid),
      eq(spamCases.textKey, textKey),
      gte(spamCases.createdAt, sinceMs),
    ))
    .orderBy(desc(spamCases.createdAt), desc(spamCases.id))
    .limit(1)
    .get() ?? null
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
