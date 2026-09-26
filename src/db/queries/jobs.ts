import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { getAccountDb } from '../account.js'
import { botJobs, botJobEvents, type BotJob, type BotJobEvent, type BotJobStatus } from '../schema.js'

export interface InsertJobParams {
  jobType: string
  groupJid?: string | null
  userJid?: string | null
  messageId?: string | null
  payload?: Record<string, unknown> | null
  runAt: number
  expiresAt?: number | null
}

function isUniqueViolation(err: unknown): boolean {
  // drizzle wraps the better-sqlite3 error; the code lives on the cause
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.cause?.code === 'SQLITE_CONSTRAINT_UNIQUE'
}

/** Insert a job. Returns the new job id, or null when a job for the same
 *  (jobType, groupJid, messageId) already exists. */
export function insertJob(params: InsertJobParams): number | null {
  const db = getAccountDb()
  try {
    const row = db.insert(botJobs).values({
      jobType: params.jobType,
      groupJid: params.groupJid ?? null,
      userJid: params.userJid ?? null,
      messageId: params.messageId ?? null,
      payload: params.payload ?? null,
      runAt: params.runAt,
      expiresAt: params.expiresAt ?? null,
    }).returning({ id: botJobs.id }).get()
    return row?.id ?? null
  } catch (err) {
    if (isUniqueViolation(err)) return null
    throw err
  }
}

export function getJob(id: number): BotJob | null {
  const db = getAccountDb()
  return db.select().from(botJobs).where(eq(botJobs.id, id)).get() ?? null
}

export function getDueJob(nowSec: number): BotJob | null {
  const db = getAccountDb()
  return db.select().from(botJobs)
    .where(and(eq(botJobs.status, 'pending'), lte(botJobs.runAt, nowSec)))
    .orderBy(botJobs.runAt, botJobs.id)
    .limit(1)
    .get() ?? null
}

export function markJobProcessing(id: number): void {
  const db = getAccountDb()
  db.update(botJobs).set({
    status: 'processing',
    attempts: sql`${botJobs.attempts} + 1`,
    updatedAt: new Date(),
  }).where(eq(botJobs.id, id)).run()
}

export function completeJob(id: number, result?: Record<string, unknown>): void {
  const db = getAccountDb()
  db.update(botJobs).set({ status: 'done', result: result ?? null, error: null, updatedAt: new Date() })
    .where(eq(botJobs.id, id)).run()
}

export function failJob(id: number, error: string): void {
  const db = getAccountDb()
  db.update(botJobs).set({ status: 'failed', error, updatedAt: new Date() })
    .where(eq(botJobs.id, id)).run()
}

export function requeueJob(id: number, error: string): void {
  const db = getAccountDb()
  db.update(botJobs).set({ status: 'pending', error, updatedAt: new Date() })
    .where(eq(botJobs.id, id)).run()
}

export function markJobExpired(id: number): void {
  const db = getAccountDb()
  db.update(botJobs).set({ status: 'expired', updatedAt: new Date() })
    .where(eq(botJobs.id, id)).run()
}

/** Crash/redeploy recovery: orphaned 'processing' jobs go back to 'pending' —
 *  unless past expiresAt (→ 'expired') or already at max attempts (→ 'failed',
 *  so a job that crashes the process cannot crash-loop it on every restart). */
export function requeueOrphanedJobs(nowSec: number, maxAttempts = 2): number {
  const db = getAccountDb()
  const expired = db.update(botJobs)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(
      eq(botJobs.status, 'processing'),
      sql`${botJobs.expiresAt} IS NOT NULL AND ${botJobs.expiresAt} < ${nowSec}`,
    )).run()
  const exhausted = db.update(botJobs)
    .set({ status: 'failed', error: `Exceeded max attempts (${maxAttempts}) after restart recovery`, updatedAt: new Date() })
    .where(and(eq(botJobs.status, 'processing'), gte(botJobs.attempts, maxAttempts))).run()
  const requeued = db.update(botJobs)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(eq(botJobs.status, 'processing')).run()
  return expired.changes + exhausted.changes + requeued.changes
}

export function addJobAiUsage(id: number, usage: { calls: number; tokensIn: number; tokensOut: number }): void {
  const db = getAccountDb()
  db.update(botJobs).set({
    aiCalls: sql`${botJobs.aiCalls} + ${usage.calls}`,
    aiTokensIn: sql`${botJobs.aiTokensIn} + ${usage.tokensIn}`,
    aiTokensOut: sql`${botJobs.aiTokensOut} + ${usage.tokensOut}`,
    updatedAt: new Date(),
  }).where(eq(botJobs.id, id)).run()
}

/** Sum of ai_calls over jobs created since UTC midnight of the given time. */
export function sumAiCallsToday(nowMs: number): number {
  const db = getAccountDb()
  const dayStart = new Date(Math.floor(nowMs / 86_400_000) * 86_400_000)
  const row = db.select({ total: sql<number>`coalesce(sum(${botJobs.aiCalls}), 0)`.as('total') })
    .from(botJobs)
    .where(gte(botJobs.createdAt, dayStart))
    .get()
  return row?.total ?? 0
}

export function addJobEvent(jobId: number, eventType: string, opts?: {
  groupJid?: string | null
  userJid?: string | null
  messageId?: string | null
  data?: Record<string, unknown> | null
}): void {
  const db = getAccountDb()
  db.insert(botJobEvents).values({
    jobId,
    eventType,
    groupJid: opts?.groupJid ?? null,
    userJid: opts?.userJid ?? null,
    messageId: opts?.messageId ?? null,
    data: opts?.data ?? null,
  }).run()
}

export function getJobEvents(jobId: number): BotJobEvent[] {
  const db = getAccountDb()
  return db.select().from(botJobEvents).where(eq(botJobEvents.jobId, jobId)).orderBy(botJobEvents.id).all()
}

export function hasJobEvent(jobId: number, eventType: string): boolean {
  const db = getAccountDb()
  return !!db.select({ id: botJobEvents.id }).from(botJobEvents)
    .where(and(eq(botJobEvents.jobId, jobId), eq(botJobEvents.eventType, eventType)))
    .limit(1).get()
}

/** The job whose reply_sent event produced this message — links a follow-up
 *  reply back to its parent exchange (payload.parentJobId). */
export function findJobIdByReplyMessage(messageId: string): number | null {
  const db = getAccountDb()
  const row = db.select({ jobId: botJobEvents.jobId }).from(botJobEvents)
    .where(and(eq(botJobEvents.eventType, 'reply_sent'), eq(botJobEvents.messageId, messageId)))
    .orderBy(desc(botJobEvents.id))
    .limit(1).get()
  return row?.jobId ?? null
}

/** Distinct groups that have at least one job — the jobs page filter source. */
export function listJobGroups(): string[] {
  const db = getAccountDb()
  const rows = db.select({ groupJid: botJobs.groupJid }).from(botJobs)
    .where(sql`${botJobs.groupJid} IS NOT NULL`)
    .groupBy(botJobs.groupJid)
    .orderBy(botJobs.groupJid)
    .all()
  return rows.map(r => r.groupJid as string)
}

export interface ListJobsFilters {
  status?: BotJobStatus
  jobType?: string
  groupJid?: string
  limit: number
  offset: number
}

export function listJobs(f: ListJobsFilters): { jobs: BotJob[]; total: number } {
  const db = getAccountDb()
  const conditions = []
  if (f.status) conditions.push(eq(botJobs.status, f.status))
  if (f.jobType) conditions.push(eq(botJobs.jobType, f.jobType))
  if (f.groupJid) conditions.push(eq(botJobs.groupJid, f.groupJid))
  const where = conditions.length ? and(...conditions) : undefined
  const jobs = db.select().from(botJobs).where(where)
    .orderBy(desc(botJobs.id)).limit(f.limit).offset(f.offset).all()
  const totalRow = db.select({ cnt: sql<number>`count(*)`.as('cnt') }).from(botJobs).where(where).get()
  return { jobs, total: totalRow?.cnt ?? 0 }
}
