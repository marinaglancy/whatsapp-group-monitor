import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { insertJob, getJob, markJobProcessing } from '../../src/db/queries/jobs.js'
import {
  registerJobHandler, clearJobHandlers, startWorker, stopWorker, signalWorker, runWorkerPass,
} from '../../src/bot/worker.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs(); clearJobHandlers() })
afterEach(() => { stopWorker(); dbs.cleanup() })

const NOW = () => Math.floor(Date.now() / 1000)

describe('worker', () => {
  it('runs a due job through its handler and stores the result', async () => {
    const seen: number[] = []
    registerJobHandler('qa_answer', async (job) => { seen.push(job.id); return { ok: true } })
    const id = insertJob({ jobType: 'qa_answer', groupJid: 'g1@g.us', messageId: 'M1', runAt: NOW() })!
    await runWorkerPass()
    expect(seen).toEqual([id])
    expect(getJob(id)!.status).toBe('done')
    expect(getJob(id)!.result).toEqual({ ok: true })
  })

  it('does not run future jobs', async () => {
    registerJobHandler('qa_answer', async () => ({}))
    const id = insertJob({ jobType: 'qa_answer', messageId: 'M1', runAt: NOW() + 3600 })!
    await runWorkerPass()
    expect(getJob(id)!.status).toBe('pending')
  })

  it('expires jobs past expiresAt without running them', async () => {
    const handler = vi.fn(async () => ({}))
    registerJobHandler('qa_answer', handler)
    const id = insertJob({ jobType: 'qa_answer', messageId: 'M1', runAt: NOW() - 700, expiresAt: NOW() - 100 })!
    await runWorkerPass()
    expect(handler).not.toHaveBeenCalled()
    expect(getJob(id)!.status).toBe('expired')
  })

  it('retries once, then fails and calls onFailure exactly once', async () => {
    let calls = 0
    const failures: string[] = []
    registerJobHandler('qa_answer', async () => { calls++; throw new Error('boom') },
      { onFailure: async (_job, error) => { failures.push(error) } })
    const id = insertJob({ jobType: 'qa_answer', messageId: 'M1', runAt: NOW() })!
    await runWorkerPass()
    expect(calls).toBe(2) // immediate retry within the same pass
    expect(getJob(id)!.status).toBe('failed')
    expect(getJob(id)!.error).toContain('boom')
    expect(failures.length).toBe(1)
  })

  it('succeeds on the retry after one failure', async () => {
    let calls = 0
    registerJobHandler('qa_answer', async () => {
      calls++
      if (calls === 1) throw new Error('flaky')
      return { ok: calls }
    })
    const id = insertJob({ jobType: 'qa_answer', messageId: 'M1', runAt: NOW() })!
    await runWorkerPass()
    expect(getJob(id)!.status).toBe('done')
    expect(getJob(id)!.attempts).toBe(2)
  })

  it('fails jobs with no registered handler', async () => {
    const id = insertJob({ jobType: 'join_request', messageId: 'M1', runAt: NOW() })!
    await runWorkerPass()
    expect(getJob(id)!.status).toBe('failed')
    expect(getJob(id)!.error).toContain('No handler')
  })

  it('recovers orphaned processing jobs once per account', async () => {
    registerJobHandler('qa_answer', async () => ({ recovered: true }))
    const id = insertJob({ jobType: 'qa_answer', messageId: 'M1', runAt: NOW() })!
    markJobProcessing(id) // simulate a crash mid-processing
    await runWorkerPass()
    expect(getJob(id)!.status).toBe('done')
    expect(getJob(id)!.result).toEqual({ recovered: true })
  })

  it('signalWorker is a no-op before startWorker', async () => {
    registerJobHandler('qa_answer', async () => ({}))
    const id = insertJob({ jobType: 'qa_answer', messageId: 'M1', runAt: NOW() })!
    signalWorker()
    await new Promise(r => setTimeout(r, 20))
    expect(getJob(id)!.status).toBe('pending')
  })

  it('startWorker ticks on the interval', async () => {
    vi.useFakeTimers()
    try {
      const handler = vi.fn(async () => ({}))
      registerJobHandler('qa_answer', handler)
      startWorker()
      await vi.runOnlyPendingTimersAsync() // flush the immediate pass
      insertJob({ jobType: 'qa_answer', messageId: 'M2', runAt: NOW() })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(handler).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
