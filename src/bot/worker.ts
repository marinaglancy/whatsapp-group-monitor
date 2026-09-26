import { isAccountDbReady, getAccountPhone } from '../db/account.js'
import {
  getDueJob, getJob, markJobProcessing, completeJob, failJob, requeueJob,
  markJobExpired, requeueOrphanedJobs,
} from '../db/queries/jobs.js'
import type { BotJob } from '../db/schema.js'
import { logger } from '../utils/logger.js'

export const WORKER_TICK_MS = 20_000
export const MAX_JOB_ATTEMPTS = 2

export type JobHandler = (job: BotJob) => Promise<Record<string, unknown> | undefined>
export interface JobHandlerOptions {
  /** Called once when the job transitions to 'failed' (attempts exhausted). */
  onFailure?: (job: BotJob, error: string) => Promise<void>
}

const handlers = new Map<string, { handler: JobHandler; opts: JobHandlerOptions }>()
let timer: NodeJS.Timeout | null = null
let running = false
let recoveredForPhone: string | null = null

export function registerJobHandler(jobType: string, handler: JobHandler, opts: JobHandlerOptions = {}): void {
  handlers.set(jobType, { handler, opts })
}

/** Tests only. */
export function clearJobHandlers(): void {
  handlers.clear()
}

export function startWorker(): void {
  if (timer) return
  timer = setInterval(() => { void runWorkerPass() }, WORKER_TICK_MS)
  timer.unref()
  void runWorkerPass()
}

export function stopWorker(): void {
  if (timer) clearInterval(timer)
  timer = null
  recoveredForPhone = null
}

/** Ask the worker to look for due jobs now. No-op unless the worker is started. */
export function signalWorker(): void {
  if (!timer) return
  void runWorkerPass()
}

export async function runWorkerPass(): Promise<void> {
  if (running) return
  if (!isAccountDbReady()) return
  running = true
  try {
    const phone = getAccountPhone()
    if (phone && phone !== recoveredForPhone) {
      const changed = requeueOrphanedJobs(nowSec())
      recoveredForPhone = phone
      if (changed > 0) logger.info({ changed }, 'Recovered orphaned bot jobs')
    }
    for (;;) {
      const job = getDueJob(nowSec())
      if (!job) break
      await runJob(job)
    }
  } catch (err) {
    logger.error({ err }, 'Worker pass failed')
  } finally {
    running = false
  }
}

async function runJob(job: BotJob): Promise<void> {
  if (job.expiresAt !== null && job.expiresAt < nowSec()) {
    markJobExpired(job.id)
    logger.info({ jobId: job.id, jobType: job.jobType }, 'Bot job expired')
    return
  }
  const entry = handlers.get(job.jobType)
  if (!entry) {
    failJob(job.id, `No handler registered for job type '${job.jobType}'`)
    return
  }
  markJobProcessing(job.id)
  const fresh = getJob(job.id)
  if (!fresh) return
  try {
    const result = await entry.handler(fresh)
    completeJob(job.id, result)
    logger.info({ jobId: job.id, jobType: job.jobType }, 'Bot job done')
  } catch (err) {
    const message = err instanceof Error ? (err.stack || err.message) : String(err)
    if (fresh.attempts < MAX_JOB_ATTEMPTS) {
      requeueJob(job.id, message)
      logger.warn({ jobId: job.id, err }, 'Bot job failed, will retry')
    } else {
      failJob(job.id, message)
      logger.error({ jobId: job.id, err }, 'Bot job failed permanently')
      if (entry.opts.onFailure) {
        try {
          await entry.opts.onFailure(fresh, message)
        } catch (notifyErr) {
          logger.error({ err: notifyErr, jobId: job.id }, 'Job onFailure notifier failed')
        }
      }
    }
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}
