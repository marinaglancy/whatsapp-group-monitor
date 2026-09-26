import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

// --- Shared DB (monitor.db) ---

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
})

// --- Account DB (account.db) ---

/** Per-group bot function settings, namespaced per function.
 *  v1 uses only `qa`; stage-2 namespaces get their real shapes when those
 *  features are designed — new fields need no migration. */
export interface GroupBotConfig {
  qa?: {
    linkedJids?: string[]
    instructions?: string
  }
  /** Reserved for stage 2+; loosely typed until designed. */
  spam?: Record<string, unknown>
  join?: Record<string, unknown>
}

export const groups = sqliteTable('groups', {
  jid: text('jid').primaryKey(),
  name: text('name').notNull(),
  isCommunity: integer('is_community', { mode: 'boolean' }).notNull().default(false),
  parentCommunityJid: text('parent_community_jid'),
  permissions: text('permissions', { mode: 'json' }).$type<{
    announce?: boolean
    restrict?: boolean
    memberAddMode?: boolean
    joinApprovalMode?: boolean
  }>(),
  botMembership: text('bot_membership', { enum: ['none', 'participant', 'admin', 'superadmin'] }).notNull().default('none'),
  botFunctions: integer('bot_functions').notNull().default(0),
  isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  // these two stay last, in ALTER order, so fresh installs match DBs that gained
  // them via migration (backup merges are positional-safe)
  botConfig: text('bot_config', { mode: 'json' }).$type<GroupBotConfig>(),
  description: text('description'),
})

export type Group = typeof groups.$inferSelect

export const membershipLevels = ['none', 'pending_approval', 'participant', 'admin', 'superadmin'] as const
export type MembershipLevel = typeof membershipLevels[number]

export const users = sqliteTable('users', {
  jid: text('jid').primaryKey(),
  phoneNumber: text('phone_number'),
  isBanned: integer('is_banned', { mode: 'boolean' }).notNull().default(false),
  displayName: text('display_name'),
  displayNameUpdatedAt: integer('display_name_updated_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
})

export const groupMembers = sqliteTable('group_members', {
  groupJid: text('group_jid').notNull().references(() => groups.jid),
  userJid: text('user_jid').notNull().references(() => users.jid),
  membership: text('membership', { enum: membershipLevels }).notNull().default('participant'),
  joinedAt: integer('joined_at', { mode: 'timestamp_ms' }),
  leftAt: integer('left_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  lastReadAt: text('last_read_at'),
}, (table) => [
  primaryKey({ columns: [table.groupJid, table.userJid] }),
])

export const activityEventTypes = [
  'message', 'reaction', 'edit', 'delete',
  'poll_create', 'poll_vote',
  'event_create', 'event_response',
  'member_joined', 'member_left',
] as const
export type ActivityEventType = typeof activityEventTypes[number]

export const groupActivityLog = sqliteTable('group_activity_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  groupJid: text('group_jid').notNull(),
  userJid: text('user_jid').notNull(),
  messageId: text('message_id').notNull(),
  parentId: text('parent_id'),
  eventType: text('event_type', { enum: activityEventTypes }).notNull(),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  raw: text('raw', { mode: 'json' }).$type<Record<string, unknown>>(),
  timestamp: integer('timestamp').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
})

export type GroupActivityRow = typeof groupActivityLog.$inferSelect

/** groups.botFunctions bit flags */
export const BOT_FUNCTION_QA = 1

export const botJobStatuses = ['pending', 'processing', 'done', 'failed', 'cancelled', 'expired'] as const
export type BotJobStatus = typeof botJobStatuses[number]

export const botJobs = sqliteTable('bot_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobType: text('job_type').notNull(),
  groupJid: text('group_jid'),
  userJid: text('user_jid'),
  messageId: text('message_id'),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
  status: text('status', { enum: botJobStatuses }).notNull().default('pending'),
  runAt: integer('run_at').notNull(),
  expiresAt: integer('expires_at'),
  attempts: integer('attempts').notNull().default(0),
  aiCalls: integer('ai_calls').notNull().default(0),
  aiTokensIn: integer('ai_tokens_in').notNull().default(0),
  aiTokensOut: integer('ai_tokens_out').notNull().default(0),
  result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
})

export type BotJob = typeof botJobs.$inferSelect

export const botJobEvents = sqliteTable('bot_job_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull().references(() => botJobs.id),
  eventType: text('event_type').notNull(),
  groupJid: text('group_jid'),
  userJid: text('user_jid'),
  messageId: text('message_id'),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
})

export type BotJobEvent = typeof botJobEvents.$inferSelect
