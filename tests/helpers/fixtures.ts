import { getAccountDb } from '../../src/db/account.js'
import { createTrigger } from '../../src/db/queries/triggers.js'
import { QA_TRIGGER_DEFAULTS } from '../../src/triggers/qa/defaults.js'
import type { QaTriggerConfig } from '../../src/triggers/qa/type.js'
import { SPAM_TRIGGER_DEFAULTS } from '../../src/triggers/spam/defaults.js'
import type { SpamTriggerConfig } from '../../src/triggers/spam/type.js'
import { createTenant, setTenantGroups } from '../../src/db/queries/tenants.js'
import { groups, users, groupMembers, groupActivityLog, type ActivityEventType, type Group, type GroupBotConfig, membershipLevels } from '../../src/db/schema.js'

export function seedGroup(jid: string, name: string, opts: Partial<{
  isCommunity: boolean
  parentCommunityJid: string | null
  botFunctions: number
  botConfig: GroupBotConfig | null
  botMembership: Group['botMembership']
}> = {}): void {
  getAccountDb().insert(groups).values({
    jid,
    name,
    isCommunity: opts.isCommunity ?? false,
    parentCommunityJid: opts.parentCommunityJid ?? null,
    botFunctions: opts.botFunctions ?? 0,
    botConfig: opts.botConfig ?? null,
    botMembership: opts.botMembership ?? 'participant',
  }).run()
}

export function seedUser(jid: string, displayName: string | null = null, phoneNumber: string | null = null): void {
  getAccountDb().insert(users).values({ jid, displayName, phoneNumber }).onConflictDoNothing().run()
}

export function seedMember(groupJid: string, userJid: string, membership: typeof membershipLevels[number] = 'participant'): void {
  seedUser(userJid)
  getAccountDb().insert(groupMembers).values({ groupJid, userJid, membership }).run()
}

let msgSeq = 0

/** Seeds a text message into the activity log. Returns its messageId. */
export function seedMessage(groupJid: string, userJid: string, text: string, timestamp: number, opts: Partial<{
  eventType: ActivityEventType
  messageId: string
  parentId: string
  metadata: Record<string, unknown>
  raw: Record<string, unknown>
}> = {}): string {
  const messageId = opts.messageId ?? `MSG${++msgSeq}`
  getAccountDb().insert(groupActivityLog).values({
    groupJid,
    userJid,
    messageId,
    parentId: opts.parentId ?? null,
    eventType: opts.eventType ?? 'message',
    metadata: opts.metadata ?? { contentType: 'conversation', text },
    raw: opts.raw ?? null,
    timestamp,
  }).run()
  return messageId
}

export function seedTenant(name: string, jids: string[]): number {
  const id = createTenant(name)
  setTenantGroups(id, jids)
  return id
}

export function seedQaTrigger(tenantId: number, qaGroupJid: string, opts: {
  config?: Partial<QaTriggerConfig>; enabled?: boolean; name?: string
} = {}): number {
  return createTrigger({
    tenantId,
    type: 'qa',
    name: opts.name ?? 'Questions',
    enabled: opts.enabled,
    config: { ...QA_TRIGGER_DEFAULTS, qaGroupJid, ...opts.config },
  })
}

export function seedSpamTrigger(tenantId: number, reportGroupJid: string, opts: {
  config?: Partial<SpamTriggerConfig>; enabled?: boolean; name?: string
} = {}): number {
  return createTrigger({
    tenantId,
    type: 'spam',
    name: opts.name ?? 'Spam',
    enabled: opts.enabled,
    config: { ...SPAM_TRIGGER_DEFAULTS, reportGroupJid, ...opts.config },
  })
}
