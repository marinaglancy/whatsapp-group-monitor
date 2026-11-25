import { getTenantIdForGroup } from '../db/queries/tenants.js'
import { listEnabledTriggers } from '../db/queries/triggers.js'
import { insertJob } from '../db/queries/jobs.js'
import { getBotJids } from '../whatsapp/handlers/connection.js'
import { wasSentByBot } from '../bot/sent-registry.js'
import { signalWorker } from '../bot/worker.js'
import { logger } from '../utils/logger.js'
import { getTriggerType } from './registry.js'
import type { DispatchCtx, TriggerEvent } from './types.js'

const warnedUnknown = new Set<number>()

/** Turn one event into jobs, walking the tenant's triggers in order.
 *  Returns the ids of the jobs created. */
export function dispatchEvent(event: TriggerEvent, nowMs: number = Date.now()): number[] {
  const record = event.record
  if (wasSentByBot(record.messageId)) return []
  const botJids = getBotJids()
  if (botJids.length === 0) return []
  const tenantId = getTenantIdForGroup(record.groupJid)
  if (tenantId === null) return []

  const ctx: DispatchCtx = { nowMs, botJids }
  const created: number[] = []
  let fired = false

  for (const row of listEnabledTriggers(tenantId)) {
    const type = getTriggerType(row.type)
    if (!type) {
      if (!warnedUnknown.has(row.id)) {
        warnedUnknown.add(row.id)
        logger.warn({ triggerId: row.id, type: row.type }, 'Trigger has an unknown type, skipping')
      }
      continue
    }
    try {
      if (type.eventKind !== event.kind) continue
      const config = type.normalize(row.config)
      if (!type.watches(event, config)) continue
      if (nowMs - record.timestamp * 1000 > config.maxAgeMinutes * 60_000) continue
      if (config.onlyIfFirst && fired) continue
      if (!type.conditions.every(c => c.check(event, config, ctx))) continue

      fired = true
      const spec = type.buildJob(event, config, ctx)
      const jobId = insertJob({
        jobType: type.jobType,
        ...spec,
        triggerId: row.id,
        runAt: Math.floor(nowMs / 1000) + config.waitSeconds,
        expiresAt: record.timestamp + config.maxAgeMinutes * 60,
      })
      if (jobId !== null) created.push(jobId)
    } catch (err) {
      logger.error({ err, triggerId: row.id }, 'Trigger failed, continuing with the next one')
    }
  }

  if (created.length > 0) signalWorker()
  return created
}
