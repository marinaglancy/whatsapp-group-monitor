import { getGroup } from '../../db/queries/groups.js'
import { isAdminLevel } from '../../db/queries/members.js'
import { TriggerType, type BaseTriggerConfig, type DispatchCtx, type JobSpec, type TriggerCondition, type TriggerEvent } from '../types.js'
import { fewerMessagesThan, joinedWithinDays, senderNotAdmin } from '../conditions.js'
import { DEFAULT_SPAM_PROMPT, SPAM_DEFAULT_ERROR_TEMPLATE, SPAM_TRIGGER_DEFAULTS } from './defaults.js'
import { hasLink, TEXT_SCAN_MAX } from '../../utils/text.js'

export interface SpamTriggerConfig extends BaseTriggerConfig {
  groupsMode: 'all' | 'only' | 'except'
  groupJids: string[]
  botRole: 'any' | 'admin' | 'not_admin'
  contentEnabled: boolean
  contentLink: boolean
  contentImage: boolean
  contentRegex: string
  senderNotAdmin: boolean
  joinedWithinDays: number | null
  maxMessages: number | null
  reportGroupJid: string
  /** Where errors are posted; '' = the report group. */
  errorGroupJid: string
  /** Spammer verdict: delete every copy found. */
  deleteSpammerCopies: boolean
  /** Spammer verdict: remove the user from the community, or else from the groups. */
  removeSpammer: boolean
  /** Spam, not a spammer: delete this message only. */
  deleteSuspicious: boolean
  prompt: string
  instructions: string
}

export const SPAM_REGEX_MAX = 200
export const SPAM_TEXT_SCAN_MAX = TEXT_SCAN_MAX
const PROMPT_MAX = 20_000
const INSTRUCTIONS_MAX = 4_000
const ERROR_TEMPLATE_MAX = 1_000

/** A group that already repeats something inside, repeated again, like (a+)+: can take forever. */
const SLOW_REGEX_RE = /\([^)]*(?:[+*]|\{\d+,\d*\})[^)]*\)(?:[+*]|\{\d+,\d*\})/

function textOf(event: TriggerEvent): string {
  const text = event.record.metadata?.text
  return typeof text === 'string' ? text : ''
}

function compileRegex(source: string): RegExp | null {
  try { return new RegExp(source, 'i') } catch { return null }
}

const regexCache = new Map<string, RegExp | null>()
function cachedRegex(source: string): RegExp | null {
  if (!regexCache.has(source)) {
    if (regexCache.size > 100) regexCache.clear()
    regexCache.set(source, compileRegex(source))
  }
  return regexCache.get(source) ?? null
}

const contentCondition: TriggerCondition<SpamTriggerConfig> = {
  id: 'spam_content',
  check(event, config) {
    if (!config.contentEnabled) return true
    const text = textOf(event)
    if (config.contentLink && hasLink(text)) return true
    if (config.contentImage && event.record.metadata?.contentType === 'imageMessage') return true
    if (config.contentRegex && config.contentRegex.length <= SPAM_REGEX_MAX) {
      const re = cachedRegex(config.contentRegex)
      if (re && re.test(text.slice(0, SPAM_TEXT_SCAN_MAX))) return true
    }
    return false
  },
}

const messageOnly: TriggerCondition<SpamTriggerConfig> = {
  id: 'message_event',
  check: event => event.record.eventType === 'message',
}

function isInt(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

export class SpamTriggerType extends TriggerType<SpamTriggerConfig> {
  readonly id = 'spam'
  readonly displayName = 'Spam'
  readonly eventKind = 'group_message' as const
  readonly jobType = 'spam_check'
  readonly defaultPrompt = DEFAULT_SPAM_PROMPT
  readonly defaultErrorTemplate = SPAM_DEFAULT_ERROR_TEMPLATE
  readonly conditions = [
    messageOnly,
    contentCondition,
    senderNotAdmin<SpamTriggerConfig>(c => c.senderNotAdmin),
    joinedWithinDays<SpamTriggerConfig>(c => c.joinedWithinDays),
    fewerMessagesThan<SpamTriggerConfig>(c => c.maxMessages),
  ]

  defaults(): SpamTriggerConfig { return { ...SPAM_TRIGGER_DEFAULTS, groupJids: [] } }

  validate(raw: unknown, ctx: { coveredGroupJids: string[] }) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false as const, error: 'Invalid settings' }
    const c = this.normalize(raw as Record<string, unknown>)
    const fail = (error: string) => ({ ok: false as const, error })
    if (typeof c.reportGroupJid !== 'string' || !ctx.coveredGroupJids.includes(c.reportGroupJid)) {
      return fail('Choose a notification group in this tenant')
    }
    if (typeof c.errorGroupJid !== 'string' || (c.errorGroupJid && !ctx.coveredGroupJids.includes(c.errorGroupJid))) {
      return fail('Choose an error group in this tenant')
    }
    if (!['all', 'only', 'except'].includes(c.groupsMode)) return fail('Invalid groups setting')
    if (!Array.isArray(c.groupJids) || !c.groupJids.every(j => typeof j === 'string' && ctx.coveredGroupJids.includes(j))) {
      return fail('Pick groups that belong to this tenant')
    }
    if (c.groupsMode !== 'all' && c.groupJids.length === 0) return fail('Pick at least one group')
    if (!['any', 'admin', 'not_admin'].includes(c.botRole)) return fail('Invalid bot role')
    for (const k of [
      'contentEnabled', 'contentLink', 'contentImage', 'senderNotAdmin', 'onlyIfFirst',
      'deleteSpammerCopies', 'removeSpammer', 'deleteSuspicious',
    ] as const) {
      if (typeof c[k] !== 'boolean') return fail('Invalid setting: ' + k)
    }
    if (typeof c.contentRegex !== 'string') return fail('Invalid text pattern')
    if (c.contentRegex.length > SPAM_REGEX_MAX) return fail(`The text pattern can be at most ${SPAM_REGEX_MAX} characters`)
    if (c.contentRegex && !compileRegex(c.contentRegex)) return fail('The text pattern is not valid')
    if (SLOW_REGEX_RE.test(c.contentRegex)) {
      return fail('This pattern can be very slow. Avoid repeating a group that already repeats, like (a+)+.')
    }
    if (c.contentEnabled && !c.contentLink && !c.contentImage && !c.contentRegex) {
      return fail('Choose at least one kind of content to check')
    }
    if (!isInt(c.waitSeconds, 0, 3600)) return fail('Wait must be a whole number from 0 to 3600 seconds')
    if (!isInt(c.maxAgeMinutes, 1, 1440)) return fail('Maximum age must be a whole number from 1 to 1440 minutes')
    if (c.waitSeconds >= c.maxAgeMinutes * 60) return fail('The wait must be shorter than the age limit.')
    if (c.joinedWithinDays !== null && !isInt(c.joinedWithinDays, 1, 3650)) return fail('Joined within must be a whole number from 1 to 3650 days')
    if (c.maxMessages !== null && !isInt(c.maxMessages, 1, 10_000)) return fail('Fewer than must be a whole number from 1 to 10000 messages')
    if (typeof c.instructions !== 'string' || c.instructions.length > INSTRUCTIONS_MAX) {
      return fail(`Instructions can be at most ${INSTRUCTIONS_MAX} characters`)
    }
    if (typeof c.prompt !== 'string' || c.prompt.length > PROMPT_MAX) return fail(`Prompt can be at most ${PROMPT_MAX} characters`)
    if (typeof c.errorTemplate !== 'string' || c.errorTemplate.length > ERROR_TEMPLATE_MAX) {
      return fail(`Error message can be at most ${ERROR_TEMPLATE_MAX} characters`)
    }
    return { ok: true as const, config: c }
  }

  summarize(config: SpamTriggerConfig, groupName: (jid: string) => string): string {
    const n = config.groupJids.length
    const plural = n === 1 ? 'group' : 'groups'
    const scope = config.groupsMode === 'all' ? 'all groups'
      : config.groupsMode === 'only' ? `only ${n} ${plural}` : `except ${n} ${plural}`
    let text = `${scope} · reports to ${groupName(config.reportGroupJid)}`
    if (config.errorGroupJid && config.errorGroupJid !== config.reportGroupJid) text += ` · errors to ${groupName(config.errorGroupJid)}`
    if (config.botRole === 'admin') text += ' · admin groups only'
    else if (config.botRole === 'not_admin') text += ' · non-admin groups only'
    if (config.onlyIfFirst) text += ' · only if no earlier trigger fired'
    if (config.waitSeconds > 0) text += ` · wait ${config.waitSeconds} s`
    if (config.deleteSpammerCopies) text += ' · deletes spam'
    if (config.removeSpammer) text += ' · removes spammers'
    if (config.deleteSuspicious) text += ' · deletes suspicious messages'
    return text
  }

  warning(config: SpamTriggerConfig, coveredGroupJids: string[]): string | null {
    if (!coveredGroupJids.includes(config.reportGroupJid)) return 'Choose a notification group in this tenant'
    if (config.errorGroupJid && !coveredGroupJids.includes(config.errorGroupJid)) return 'The error group is not in this tenant'
    return null
  }

  /** Whether the groups setting picks the group. The report and error groups
   *  are never checked: people there discuss the reports and errors. */
  selectsGroup(jid: string, config: SpamTriggerConfig): boolean {
    if (jid === config.reportGroupJid || jid === config.errorGroupJid) return false
    if (config.groupsMode === 'only' && !config.groupJids.includes(jid)) return false
    if (config.groupsMode === 'except' && config.groupJids.includes(jid)) return false
    return true
  }

  /** The dispatcher only offers this trigger events from its own tenant's groups,
   *  so only the groups setting and the bot's role are checked here. */
  watches(event: TriggerEvent, config: SpamTriggerConfig): boolean {
    const jid = event.record.groupJid
    if (!this.selectsGroup(jid, config)) return false
    if (config.botRole === 'any') return true
    const isAdmin = isAdminLevel(getGroup(jid)?.botMembership)
    return config.botRole === 'admin' ? isAdmin : !isAdmin
  }

  buildJob(event: TriggerEvent, _config: SpamTriggerConfig, _ctx: DispatchCtx): JobSpec {
    const { record } = event
    return {
      groupJid: record.groupJid,
      userJid: record.userJid,
      messageId: record.messageId,
      payload: {
        text: textOf(event),
        contentType: typeof record.metadata?.contentType === 'string' ? record.metadata.contentType : null,
      },
    }
  }
}

export const spamTriggerType = new SpamTriggerType()
