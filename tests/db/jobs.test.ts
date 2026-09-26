import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import {
  insertJob, getJob, getDueJob, markJobProcessing, completeJob, failJob, requeueJob,
  markJobExpired, requeueOrphanedJobs, addJobAiUsage, sumAiCallsToday,
  addJobEvent, getJobEvents, hasJobEvent, listJobs, listJobGroups,
} from '../../src/db/queries/jobs.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs() })
afterEach(() => { dbs.cleanup() })

const NOW = 1_800_000_000 // unix seconds

function makeJob(over: Partial<Parameters<typeof insertJob>[0]> = {}) {
  return insertJob({ jobType: 'qa_answer', groupJid: 'g1@g.us', userJid: 'u1@s.whatsapp.net', messageId: `M${Math.random()}`, payload: { text: 'q' }, runAt: NOW, ...over })
}

describe('job store', () => {
  it('inserts and reads back a job with JSON payload', () => {
    const id = insertJob({ jobType: 'qa_answer', groupJid: 'g1@g.us', messageId: 'M1', payload: { text: 'hello', n: 2 }, runAt: NOW, expiresAt: NOW + 600 })
    expect(id).not.toBeNull()
    const job = getJob(id!)
    expect(job!.status).toBe('pending')
    expect(job!.payload).toEqual({ text: 'hello', n: 2 })
    expect(job!.expiresAt).toBe(NOW + 600)
    expect(job!.aiCalls).toBe(0)
  })

  it('returns null on duplicate (jobType, groupJid, messageId)', () => {
    expect(makeJob({ messageId: 'DUP' })).not.toBeNull()
    expect(makeJob({ messageId: 'DUP' })).toBeNull()
  })

  it('picks due jobs oldest-first and ignores future runAt', () => {
    const late = makeJob({ runAt: NOW + 100, messageId: 'L' })!
    const early = makeJob({ runAt: NOW - 100, messageId: 'E' })!
    expect(getDueJob(NOW)!.id).toBe(early)
    markJobExpired(early)
    expect(getDueJob(NOW)).toBeNull()
    expect(getDueJob(NOW + 100)!.id).toBe(late)
  })

  it('markJobProcessing increments attempts', () => {
    const id = makeJob()!
    markJobProcessing(id)
    expect(getJob(id)!.attempts).toBe(1)
    expect(getJob(id)!.status).toBe('processing')
    requeueJob(id, 'boom')
    markJobProcessing(id)
    expect(getJob(id)!.attempts).toBe(2)
    expect(getJob(id)!.error).toBe('boom')
  })

  it('completes and fails with result/error stored', () => {
    const a = makeJob()!
    completeJob(a, { replyMessageId: 'R1' })
    expect(getJob(a)!.status).toBe('done')
    expect(getJob(a)!.result).toEqual({ replyMessageId: 'R1' })
    const b = makeJob()!
    failJob(b, 'it broke')
    expect(getJob(b)!.status).toBe('failed')
    expect(getJob(b)!.error).toBe('it broke')
  })

  it('clears a stale error when a retried job completes', () => {
    const id = makeJob()!
    markJobProcessing(id)
    requeueJob(id, 'first attempt boom')
    markJobProcessing(id)
    completeJob(id, { ok: true })
    expect(getJob(id)!.status).toBe('done')
    expect(getJob(id)!.error).toBeNull()
  })

  it('requeueOrphanedJobs fails jobs that already exhausted their attempts', () => {
    const poison = makeJob()!
    markJobProcessing(poison)
    requeueJob(poison, 'crash 1')
    markJobProcessing(poison) // attempts now 2 == max; process "crashes" here
    expect(requeueOrphanedJobs(NOW, 2)).toBe(1)
    expect(getJob(poison)!.status).toBe('failed')
    expect(getJob(poison)!.error).toMatch(/attempts/i)
  })

  it('requeueOrphanedJobs: processing → pending, expired stays expired', () => {
    const fresh = makeJob({ expiresAt: NOW + 600 })!
    const stale = makeJob({ expiresAt: NOW - 10 })!
    markJobProcessing(fresh)
    markJobProcessing(stale)
    const changed = requeueOrphanedJobs(NOW)
    expect(changed).toBe(2)
    expect(getJob(fresh)!.status).toBe('pending')
    expect(getJob(stale)!.status).toBe('expired')
  })

  it('accumulates AI usage and sums calls for today only', () => {
    const id = makeJob()!
    addJobAiUsage(id, { calls: 1, tokensIn: 100, tokensOut: 20 })
    addJobAiUsage(id, { calls: 1, tokensIn: 50, tokensOut: 5 })
    const job = getJob(id)!
    expect(job.aiCalls).toBe(2)
    expect(job.aiTokensIn).toBe(150)
    expect(job.aiTokensOut).toBe(25)
    expect(sumAiCallsToday(Date.now())).toBe(2)
    // a "yesterday" job is excluded: sumAiCallsToday for tomorrow sees 0
    expect(sumAiCallsToday(Date.now() + 86_400_000)).toBe(0)
  })

  it('records and lists job events in order', () => {
    const id = makeJob()!
    addJobEvent(id, 'ai_call', { data: { round: 1 } })
    addJobEvent(id, 'tool_call', { data: { name: 'list_groups' } })
    addJobEvent(id, 'reply_sent', { messageId: 'R9', data: { chars: 42 } })
    const events = getJobEvents(id)
    expect(events.map(e => e.eventType)).toEqual(['ai_call', 'tool_call', 'reply_sent'])
    expect(events[2].messageId).toBe('R9')
    expect(hasJobEvent(id, 'reply_sent')).toBe(true)
    expect(hasJobEvent(id, 'dm_sent')).toBe(false)
  })

  it('lists the distinct groups that have jobs', () => {
    makeJob({ groupJid: 'g1@g.us', messageId: 'A' })
    makeJob({ groupJid: 'g1@g.us', messageId: 'B' })
    makeJob({ groupJid: 'g2@g.us', messageId: 'C' })
    makeJob({ groupJid: null, messageId: 'D' })
    expect(listJobGroups()).toEqual(['g1@g.us', 'g2@g.us'])
  })

  it('lists jobs with filters, paging and total', () => {
    for (let i = 0; i < 5; i++) makeJob({ messageId: `Q${i}` })
    const other = makeJob({ jobType: 'spam_check', groupJid: 'g2@g.us', messageId: 'S1' })!
    failJob(other, 'x')
    expect(listJobs({ limit: 3, offset: 0 }).total).toBe(6)
    expect(listJobs({ limit: 3, offset: 0 }).jobs.length).toBe(3)
    expect(listJobs({ limit: 3, offset: 0 }).jobs[0].id).toBe(other) // newest first
    expect(listJobs({ jobType: 'spam_check', limit: 10, offset: 0 }).total).toBe(1)
    expect(listJobs({ status: 'failed', limit: 10, offset: 0 }).jobs[0].id).toBe(other)
    expect(listJobs({ groupJid: 'g2@g.us', limit: 10, offset: 0 }).total).toBe(1)
  })
})
