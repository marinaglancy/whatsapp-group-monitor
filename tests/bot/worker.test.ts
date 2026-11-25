import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { insertJob, getJob, markJobProcessing } from '../../src/db/queries/jobs.js'
import { logger } from '../../src/utils/logger.js'
import { TriggerJobError, TriggerGoneError } from '../../src/triggers/errors.js'
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

  it('logs expected trigger failures as warnings without a stack, and other failures as errors', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    let n = 0
    const errs = [new TriggerJobError('no key'), new TriggerGoneError('trigger 5 is gone'), new Error('boom')]
    registerJobHandler('qa_answer', async () => { throw errs[n++] }, { shouldRetry: () => false })
    const ids = [1, 2, 3].map(i => insertJob({ jobType: 'qa_answer', messageId: `M${i}`, runAt: NOW() })!)
    await runWorkerPass()
    expect(warn).toHaveBeenCalledWith({ jobId: ids[0], error: 'no key' }, expect.any(String))
    expect(warn).toHaveBeenCalledWith({ jobId: ids[1], error: 'trigger 5 is gone' }, expect.any(String))
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ jobId: ids[2] }), 'Bot job failed permanently')
    expect(new TriggerJobError('x').name).toBe('TriggerJobError')
    expect(new TriggerGoneError('x').name).toBe('TriggerGoneError')
  })

  it('fails at once, without a retry, when shouldRetry rejects the error', async () => {
    let calls = 0
    const failures: string[] = []
    registerJobHandler('qa_answer', async () => { calls++; throw new Error('permanent') }, {
      shouldRetry: () => false,
      onFailure: async (_job, error) => { failures.push(error) },
    })
    const id = insertJob({ jobType: 'qa_answer', messageId: 'M1', runAt: NOW() })!
    await runWorkerPass()
    expect(calls).toBe(1)
    expect(getJob(id)!.status).toBe('failed')
    expect(getJob(id)!.attempts).toBe(1)
    expect(failures.length).toBe(1)
  })

  it('passes the thrown error object to onFailure', async () => {
    const boom = new Error('boom')
    const failures: { jobId: number; error: string; err: unknown }[] = []
    registerJobHandler('qa_answer', async () => { throw boom }, {
      shouldRetry: () => false,
      onFailure: async (job, error, err) => { failures.push({ jobId: job.id, error, err }) },
    })
    const id = insertJob({ jobType: 'qa_answer', messageId: 'M1', runAt: NOW() })!
    await runWorkerPass()
    expect(failures.length).toBe(1)
    expect(failures[0].jobId).toBe(id)
    expect(failures[0].err).toBe(boom)
    expect(failures[0].error).toContain('boom')
  })

  it('hands the thrown error to shouldRetry and retries when it agrees', async () => {
    let calls = 0
    const asked: string[] = []
    registerJobHandler('qa_answer', async () => { calls++; throw new Error(`busy ${calls}`) }, {
      shouldRetry: (err) => { asked.push((err as Error).message); return true },
    })
    const id = insertJob({ jobType: 'qa_answer', messageId: 'M1', runAt: NOW() })!
    await runWorkerPass()
    expect(calls).toBe(2)
    expect(asked).toEqual(['busy 1']) // not asked after the last attempt
    expect(getJob(id)!.status).toBe('failed')
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

  it('re-runs orphan recovery after the account db was closed and reopened', async () => {
    const { closeAccountDb, initAccountDb } = await import('../../src/db/account.js')
    const { TEST_PHONE } = await import('../helpers/db.js')
    registerJobHandler('qa_answer', async () => ({ ok: true }))
    await runWorkerPass() // arms recoveredForPhone for this phone
    closeAccountDb()
    await runWorkerPass() // must notice the DB is gone and re-arm recovery
    initAccountDb(TEST_PHONE)
    const id = insertJob({ jobType: 'qa_answer', messageId: 'M1', runAt: NOW() })!
    markJobProcessing(id) // orphaned by the simulated disconnect
    await runWorkerPass()
    expect(getJob(id)!.status).toBe('done')
  })

  it('fails a hung handler via the watchdog without a retry, even when shouldRetry agrees', async () => {
    vi.useFakeTimers()
    try {
      registerJobHandler('qa_answer', () => new Promise(() => { /* never settles */ }), { shouldRetry: () => true })
      const id = insertJob({ jobType: 'qa_answer', messageId: 'M1', runAt: NOW() })!
      const pass = runWorkerPass()
      // the hung attempt is still running, so a retry could reply twice
      await vi.advanceTimersByTimeAsync(120_000) // attempt 1 times out → failed, no retry
      await pass
      expect(getJob(id)!.status).toBe('failed')
      expect(getJob(id)!.error).toMatch(/timed out/i)
      expect(getJob(id)!.attempts).toBe(1)
    } finally {
      vi.useRealTimers()
    }
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
