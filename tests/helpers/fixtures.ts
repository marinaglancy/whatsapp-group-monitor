import { getAccountDb } from '../../src/db/account.js'
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

export function seedUser(jid: string, displayName: string | null = null): void {
  getAccountDb().insert(users).values({ jid, displayName }).onConflictDoNothing().run()
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
}> = {}): string {
  const messageId = opts.messageId ?? `MSG${++msgSeq}`
  getAccountDb().insert(groupActivityLog).values({
    groupJid,
    userJid,
    messageId,
    parentId: opts.parentId ?? null,
    eventType: opts.eventType ?? 'message',
    metadata: opts.metadata ?? { contentType: 'conversation', text },
    raw: null,
    timestamp,
  }).run()
  return messageId
}
