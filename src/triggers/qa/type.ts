import { getCreationRecord } from '../../db/queries/activity.js'
import { findJobIdByReplyMessage } from '../../db/queries/jobs.js'
import { TriggerType, type BaseTriggerConfig, type DispatchCtx, type JobSpec, type TriggerCondition, type TriggerEvent } from '../types.js'
import { QA_INSTRUCTIONS_MAX, QA_TRIGGER_DEFAULTS } from './defaults.js'

export interface QaTriggerConfig extends BaseTriggerConfig {
  qaGroupJid: string
  prompt: string
  instructions: string
}

const PROMPT_MAX = 20_000
const ERROR_TEMPLATE_MAX = 1_000

function messageText(event: TriggerEvent): string {
  const text = event.record.metadata?.text
  return typeof text === 'string' ? text.trim() : ''
}

/** The id of the bot message this one replies to, or null if it is not a reply to the bot. */
function quotedBotMessageId(event: TriggerEvent, botJids: string[]): string | null {
  const { record } = event
  if (!record.parentId) return null
  const parent = getCreationRecord(record.groupJid, record.parentId)
  return parent && botJids.includes(parent.userJid) ? record.parentId : null
}

function mentionsBot(event: TriggerEvent, botJids: string[]): boolean {
  const mentions = event.record.metadata?.mentions
  return Array.isArray(mentions) && (mentions as string[]).some(j => botJids.includes(j))
}

const mentionOrReply: TriggerCondition<QaTriggerConfig> = {
  id: 'mention_or_reply',
  check(event, _config, ctx) {
    if (event.record.eventType !== 'message') return false
    if (!messageText(event)) return false
    return mentionsBot(event, ctx.botJids) || quotedBotMessageId(event, ctx.botJids) !== null
  },
}

function isInt(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

export class QaTriggerType extends TriggerType<QaTriggerConfig> {
  readonly id = 'qa'
  readonly displayName = 'Questions'
  readonly eventKind = 'group_message' as const
  readonly jobType = 'qa_answer'
  readonly conditions = [mentionOrReply]

  defaults(): QaTriggerConfig { return { ...QA_TRIGGER_DEFAULTS } }

  validate(raw: unknown, ctx: { coveredGroupJids: string[] }) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false as const, error: 'Invalid settings' }
    const c = this.normalize(raw as Record<string, unknown>)
    if (typeof c.qaGroupJid !== 'string' || !ctx.coveredGroupJids.includes(c.qaGroupJid)) {
      return { ok: false as const, error: 'Pick a group that belongs to this tenant' }
    }
    if (!isInt(c.waitSeconds, 0, 3600)) return { ok: false as const, error: 'Wait must be a whole number from 0 to 3600 seconds' }
    if (!isInt(c.maxAgeMinutes, 1, 1440)) return { ok: false as const, error: 'Maximum age must be a whole number from 1 to 1440 minutes' }
    if (typeof c.onlyIfFirst !== 'boolean') return { ok: false as const, error: 'Invalid "only if first" value' }
    if (typeof c.instructions !== 'string' || c.instructions.length > QA_INSTRUCTIONS_MAX) {
      return { ok: false as const, error: `Instructions can be at most ${QA_INSTRUCTIONS_MAX} characters` }
    }
    if (typeof c.prompt !== 'string' || c.prompt.length > PROMPT_MAX) {
      return { ok: false as const, error: `Prompt can be at most ${PROMPT_MAX} characters` }
    }
    if (typeof c.errorTemplate !== 'string' || c.errorTemplate.length > ERROR_TEMPLATE_MAX) {
      return { ok: false as const, error: `Error message can be at most ${ERROR_TEMPLATE_MAX} characters` }
    }
    return { ok: true as const, config: c }
  }

  watches(event: TriggerEvent, config: QaTriggerConfig): boolean {
    return event.record.groupJid === config.qaGroupJid
  }

  buildJob(event: TriggerEvent, _config: QaTriggerConfig, ctx: DispatchCtx): JobSpec {
    const { record } = event
    const quoted = quotedBotMessageId(event, ctx.botJids)
    // Only a reply (no mention) counts as a quote, as before this became a trigger.
    const quotedId = mentionsBot(event, ctx.botJids) ? null : quoted
    const parentJobId = quotedId ? findJobIdByReplyMessage(quotedId) : null
    return {
      groupJid: record.groupJid,
      userJid: record.userJid,
      messageId: record.messageId,
      payload: {
        text: messageText(event),
        ...(quotedId ? { quotedBotMessageId: quotedId } : {}),
        ...(parentJobId !== null ? { parentJobId } : {}),
      },
    }
  }
}

export const qaTriggerType = new QaTriggerType()
