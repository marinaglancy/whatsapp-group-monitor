import type { BotJob, BotTrigger } from '../db/schema.js'
import { getTrigger } from '../db/queries/triggers.js'
import { getGroup } from '../db/queries/groups.js'
import { addJobEvent, hasJobEvent } from '../db/queries/jobs.js'
import { getTriggerType } from './registry.js'
import { TriggerGoneError, errorTextFor, renderErrorTemplate } from './errors.js'
import type { BaseTriggerConfig } from './types.js'
import { logger } from '../utils/logger.js'

/** Longest message text put into the error template's {{message}}. */
export const ERROR_MESSAGE_TEXT_MAX = 200

/** Where a trigger type posts its errors. */
export interface ErrorTarget {
  /** Post the rendered error text; returns the group it was posted in and the
   *  message id, recorded on the error_sent event. */
  send(job: BotJob, trigger: BotTrigger, text: string): Promise<{ groupJid: string; messageId: string | null } | null>
  /** At most one post per trigger in this period; others are only logged. 0 = no throttle. */
  throttleMs: number
}

/** Trigger id → time of its last error post (ms). */
const lastPostAt = new Map<number, number>()

/** Tests only: forget all error posts. */
export function resetErrorThrottleForTests(): void {
  lastPostAt.clear()
}

function bareId(jid: string): string {
  return jid.split(':')[0].split('@')[0]
}

/** onFailure notifier for the worker: posts the trigger's error template to
 *  the type's target, with a short {{error}} text, never internals. Stays
 *  silent when the answer was already sent (a late crash), or when the job's
 *  trigger is gone. */
export function buildTriggerErrorNotifier(target: ErrorTarget, now: () => number = () => Date.now()) {
  return async function notifyTriggerError(job: BotJob, error: string, err: unknown): Promise<void> {
    if (hasJobEvent(job.id, 'reply_sent') || err instanceof TriggerGoneError) return
    const trigger = job.triggerId === null ? null : getTrigger(job.triggerId)
    if (!trigger) return
    const type = getTriggerType(trigger.type)
    if (!type) {
      logger.warn({ jobId: job.id, type: trigger.type }, 'No error message: unknown trigger type')
      return
    }
    const config: BaseTriggerConfig = type.normalize(trigger.config)
    const message = typeof job.payload?.text === 'string' ? job.payload.text : ''
    const text = renderErrorTemplate(config.errorTemplate.trim() || type.defaultErrorTemplate, {
      error: errorTextFor(err, error),
      trigger: trigger.name,
      group: (job.groupJid && getGroup(job.groupJid)?.name) || job.groupJid || '',
      user: job.userJid ? '@' + bareId(job.userJid) : '',
      message: message.slice(0, ERROR_MESSAGE_TEXT_MAX),
    })

    // the slot is taken before the send, so two failures at the same moment cannot both post
    const previous = lastPostAt.get(trigger.id)
    if (target.throttleMs > 0) {
      const t = now()
      if (previous !== undefined && t - previous < target.throttleMs) {
        logger.info({ jobId: job.id, triggerId: trigger.id, text }, 'Error message not posted: one was posted for this trigger recently')
        return
      }
      lastPostAt.set(trigger.id, t)
    }
    try {
      const posted = await target.send(job, trigger, text)
      addJobEvent(job.id, 'error_sent', { groupJid: posted?.groupJid ?? null, messageId: posted?.messageId ?? null })
    } catch (sendErr) {
      // nothing was posted: the next error may try again
      if (target.throttleMs > 0) {
        if (previous === undefined) lastPostAt.delete(trigger.id)
        else lastPostAt.set(trigger.id, previous)
      }
      logger.error({ err: sendErr, jobId: job.id }, 'Failed to send the error message')
    }
  }
}
