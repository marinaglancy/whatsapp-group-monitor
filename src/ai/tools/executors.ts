import { formatDateTime, parseDateTime } from '../../utils/time.js'
import type { QaScope } from '../../bot/scope.js'
import {
  qGroupMembers, qGroupMessages, qActivityStats, qSearchMessages, qUsersByJids, qFindUserJid,
  type QaMemberFilters, type QaStatsRange,
} from '../../db/queries/group-tools.js'
import { getAllGroups } from '../../db/queries/groups.js'
import { logger } from '../../utils/logger.js'

export const TOOL_RESULT_MAX_BYTES = 32_000

export const TOOL_LIMITS: Record<string, { def: number; max: number }> = {
  group_list: { def: 100, max: 200 },
  group_members: { def: 50, max: 500 },
  group_messages: { def: 50, max: 200 },
  message_search: { def: 20, max: 100 },
}

export interface ToolExecCtx {
  scope: QaScope
  timezone: string
  nowMs?: () => number
}

class ToolError extends Error {}

const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v))
const sizeError = (n: number) =>
  `Result was ${n} bytes, maximum allowed is ${TOOL_RESULT_MAX_BYTES}. Reduce the limit, request fewer fields, or narrow the range.`

function bareId(jid: string): string {
  return jid.split(':')[0].split('@')[0]
}

/** Resolve requested group/community jids against the scope into concrete group jids. */
function resolveJids(argJids: unknown, scope: QaScope): string[] {
  if (argJids === undefined || argJids === null || (Array.isArray(argJids) && argJids.length === 0)) {
    return scope.groupJids
  }
  if (!Array.isArray(argJids) || argJids.some(j => typeof j !== 'string')) {
    throw new ToolError('group_jids must be an array of jid strings')
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const jid of argJids as string[]) {
    const entry = scope.entries.find(e => e.jid === jid)
    const concrete = entry?.isCommunity ? entry.children.map(c => c.jid)
      : scope.groupJids.includes(jid) ? [jid]
      : null
    if (!concrete) throw new ToolError(`Group ${jid} is not in scope. Call group_list to see the available groups.`)
    for (const j of concrete) if (!seen.has(j)) { seen.add(j); out.push(j) }
  }
  return out
}

function clampLimit(tool: string, v: unknown): number {
  const { def, max } = TOOL_LIMITS[tool]
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def
  return Math.min(Math.max(n, 1), max)
}

function parseOffset(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0
  return Math.max(n, 0)
}

function dt(ctx: ToolExecCtx, v: unknown, edge: 'start' | 'end', fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v !== 'string') throw new ToolError("Datetimes must be strings like 'YYYY-MM-DD HH:MM:SS'")
  try {
    return parseDateTime(v, ctx.timezone, edge)
  } catch (err) {
    throw new ToolError(err instanceof Error ? err.message : String(err))
  }
}

function checkRange(from: number, to: number): void {
  if (from > to) throw new ToolError('from must be earlier than or equal to to')
}

/** Person references may arrive as full jids, bare lid digits (from person
 *  strings) or phone numbers — resolve to the stored jid, or error clearly. */
function resolvePersonRef(value: unknown, param: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`${param} must be a member reference string`)
  const jid = qFindUserJid(value.trim())
  if (!jid) throw new ToolError(`Unknown member '${value}' in ${param} — use a lid from group_members`)
  return jid
}

function intArg(value: unknown, param: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) throw new ToolError(`${param} must be a number`)
  return Math.floor(n)
}

type UserInfo = Map<string, { name: string | null; phone: string | null }>

function person(lid: string, users: UserInfo): string {
  const u = users.get(lid)
  const name = u?.name ? ` ${u.name}` : ''
  return `${bareId(lid)} ${u?.phone ?? '-'}${name}`
}

/** Adaptive paging: keep up to `rows.length` rows but never exceed the byte budget. */
function paginate(rowsKey: string, rows: unknown[], total: number, offset: number): Record<string, unknown> {
  let kept = rows.length
  const build = (k: number): Record<string, unknown> => {
    const hasMore = offset + k < total
    return {
      [rowsKey]: rows.slice(0, k),
      total,
      has_more: hasMore,
      ...(hasMore ? { next_offset: offset + k } : {}),
    }
  }
  let payload = build(kept)
  while (kept > 0 && jsonBytes(payload) > TOOL_RESULT_MAX_BYTES) {
    kept--
    payload = build(kept)
  }
  if (kept === 0 && rows.length > 0) {
    throw new ToolError(sizeError(jsonBytes(build(1))))
  }
  return payload
}

const GROUP_LIST_FIELDS = ['description', 'is_community', 'parent_jid', 'member_count', 'bot_role', 'announcement_only', 'bot_can_post', 'last_activity', 'join_approval_required'] as const
const MEMBER_FIELDS = ['phone', 'role', 'last_activity', 'activity_count', 'joined_at', 'left_at', 'groups', 'last_read'] as const

function fieldSet(v: unknown, allowed: readonly string[], omittedMeansAll: boolean): Set<string> {
  // an empty array is treated like omission (models frequently send [])
  if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) {
    return new Set(omittedMeansAll ? allowed : [])
  }
  if (!Array.isArray(v) || v.some(f => typeof f !== 'string')) throw new ToolError('fields must be an array of field names')
  for (const f of v as string[]) {
    if (!allowed.includes(f)) throw new ToolError(`Unknown field '${f}'. Available: ${allowed.join(', ')}`)
  }
  return new Set(v as string[])
}

type Executor = (args: Record<string, unknown>, ctx: ToolExecCtx) => unknown

const executors: Record<string, Executor> = {

  group_list(args, ctx) {
    const fields = fieldSet(args.fields, GROUP_LIST_FIELDS, false)
    const limit = clampLimit('group_list', args.limit)
    const offset = parseOffset(args.offset)
    const scopeJids = new Set([
      ...ctx.scope.groupJids,
      ...ctx.scope.entries.filter(e => e.isCommunity).map(e => e.jid),
    ])
    let wanted: Set<string>
    if (args.group_jids === undefined || args.group_jids === null || (Array.isArray(args.group_jids) && args.group_jids.length === 0)) {
      wanted = scopeJids
    } else {
      if (!Array.isArray(args.group_jids) || (args.group_jids as unknown[]).some(j => typeof j !== 'string')) {
        throw new ToolError('group_jids must be an array of jid strings')
      }
      for (const j of args.group_jids as string[]) {
        if (!scopeJids.has(j)) throw new ToolError(`Group ${j} is not in scope. Call group_list to see the available groups.`)
      }
      wanted = new Set(args.group_jids as string[])
    }
    const records = getAllGroups()
      .filter(g => wanted.has(g.jid))
      .sort((a, b) => a.name.localeCompare(b.name) || (a.jid < b.jid ? -1 : 1))
    const total = records.length
    const page = records.slice(offset, offset + limit)
    const rows = page.map(g => ({
      jid: g.jid,
      name: g.name,
      ...(fields.has('description') && g.description ? { description: g.description } : {}),
      ...(fields.has('is_community') ? { is_community: g.isCommunity } : {}),
      ...(fields.has('parent_jid') && g.parentCommunityJid ? { parent_jid: g.parentCommunityJid } : {}),
      ...(fields.has('member_count') ? { member_count: g.getMemberCount() } : {}),
      ...(fields.has('bot_role') && g.botMembership !== 'none' ? { bot_role: g.botMembership } : {}),
      ...(fields.has('announcement_only') ? { announcement_only: g.permissions?.announce ?? false } : {}),
      ...(fields.has('bot_can_post') ? { bot_can_post: !(g.permissions?.announce ?? false) || g.botMembership === 'admin' || g.botMembership === 'superadmin' } : {}),
      ...(fields.has('join_approval_required') ? { join_approval_required: g.permissions?.joinApprovalMode ?? false } : {}),
      ...(fields.has('last_activity') ? (() => {
        const ts = g.getLastActivity()
        return ts ? { last_activity: formatDateTime(ts, ctx.timezone) } : {}
      })() : {}),
    }))
    return paginate('groups', rows, total, offset)
  },

  group_members(args, ctx) {
    const now = (ctx.nowMs ?? (() => Date.now()))()
    const jids = resolveJids(args.group_jids, ctx.scope)
    const fields = fieldSet(args.fields, MEMBER_FIELDS, true)
    const from = dt(ctx, args.activity_from, 'start', Math.floor(now / 1000) - 30 * 86_400)
    const to = dt(ctx, args.activity_to, 'end', Math.floor(now / 1000))
    checkRange(from, to)
    const filters: QaMemberFilters = {}
    if (typeof args.name_contains === 'string' && args.name_contains) filters.nameContains = args.name_contains
    if (typeof args.phone_contains === 'string' && args.phone_contains) filters.phoneContains = args.phone_contains
    if (Array.isArray(args.lids) && args.lids.length) {
      filters.lids = (args.lids as unknown[]).map(l => resolvePersonRef(l, 'lids'))
    }
    if (args.role !== undefined) {
      if (args.role !== 'participant' && args.role !== 'admin' && args.role !== 'superadmin') throw new ToolError('role must be participant, admin or superadmin')
      filters.role = args.role
    }
    if (args.min_activity_count !== undefined) filters.minActivityCount = intArg(args.min_activity_count, 'min_activity_count')
    if (args.max_activity_count !== undefined) filters.maxActivityCount = intArg(args.max_activity_count, 'max_activity_count')
    if (args.last_activity_before !== undefined) filters.lastActivityBefore = dt(ctx, args.last_activity_before, 'start', 0)
    if (args.last_activity_after !== undefined) filters.lastActivityAfter = dt(ctx, args.last_activity_after, 'start', 0)
    const orderBy = (args.order_by as string | undefined) ?? 'lid'
    if (!['lid', 'phone', 'name', 'last_activity', 'activity_count', 'joined_at'].includes(orderBy)) {
      throw new ToolError(`Unknown order_by '${orderBy}'`)
    }
    const order = args.order === 'desc' ? 'desc' : 'asc'
    const limit = clampLimit('group_members', args.limit)
    const offset = parseOffset(args.offset)
    const { members, total } = qGroupMembers({ groupJids: jids }, {
      activityFrom: from, activityTo: to, filters,
      includeLeft: args.include_left === true,
      orderBy, order, limit, offset,
    })
    const rows = members.map(m => ({
      lid: m.lid,
      ...(m.name ? { name: m.name } : {}),
      ...(fields.has('phone') && m.phone ? { phone: m.phone } : {}),
      ...(fields.has('role') && m.role !== 'none' ? { role: m.role } : {}),
      ...(fields.has('last_activity') && m.lastActivity ? { last_activity: formatDateTime(m.lastActivity, ctx.timezone) } : {}),
      ...(fields.has('activity_count') ? { activity_count: m.activityCount } : {}),
      ...(fields.has('joined_at') && m.joinedAt ? { joined_at: formatDateTime(m.joinedAt, ctx.timezone) } : {}),
      ...(fields.has('left_at') && m.leftAt && m.role === 'none' ? { left_at: formatDateTime(m.leftAt, ctx.timezone) } : {}),
      ...(fields.has('last_read') && m.lastRead ? { last_read: m.lastRead } : {}),
      ...(fields.has('groups') && m.groups ? { groups: m.groups } : {}),
    }))
    return paginate('members', rows, total, offset)
  },

  group_messages(args, ctx) {
    const now = (ctx.nowMs ?? (() => Date.now()))()
    const jids = resolveJids(args.group_jids, ctx.scope)
    const from = dt(ctx, args.from, 'start', Math.floor(now / 1000) - 7 * 86_400)
    const to = dt(ctx, args.to, 'end', Math.floor(now / 1000))
    checkRange(from, to)
    let types: string[] | undefined
    if (args.types !== undefined) {
      if (!Array.isArray(args.types) || (args.types as unknown[]).some(t => !['message', 'poll', 'event'].includes(t as string))) {
        throw new ToolError('types entries must be message, poll or event')
      }
      types = args.types as string[]
    }
    let memberLid: string | undefined
    let memberPhone: string | null = null
    if (args.member_lid !== undefined) {
      memberLid = resolvePersonRef(args.member_lid, 'member_lid')
      memberPhone = qUsersByJids([memberLid]).get(memberLid)?.phone ?? null
    }
    const order = args.order === 'desc' ? 'desc' : 'asc'
    const limit = clampLimit('group_messages', args.limit)
    const offset = parseOffset(args.offset)
    const { messages, total } = qGroupMessages({ groupJids: jids }, {
      from, to, types, memberLid, memberPhone,
      hasReactions: args.has_reactions === true ? true : undefined,
      includeDeleted: args.include_deleted === true,
      order, limit, offset,
    })
    const lids = new Set<string>()
    for (const m of messages) {
      lids.add(m.authorLid)
      if (m.deletedBy) lids.add(m.deletedBy)
      for (const r of m.reactions) for (const u of r.by) lids.add(u)
      if (m.poll) for (const o of m.poll.options) for (const u of o.votes) lids.add(u)
      if (m.event) for (const list of Object.values(m.event.responses)) for (const u of list) lids.add(u)
    }
    const users = qUsersByJids([...lids])
    const rows = messages.map(m => ({
      id: m.messageId,
      group_jid: m.groupJid,
      sent_at: formatDateTime(m.timestamp, ctx.timezone),
      author: { lid: m.authorLid, ...(users.get(m.authorLid)?.name ? { name: users.get(m.authorLid)!.name } : {}) },
      type: m.type,
      ...(m.text ? { text: m.text } : {}),
      ...(m.edited ? { edited: true } : {}),
      ...(m.replyToId ? { reply_to_id: m.replyToId } : {}),
      ...(m.media ? { media: m.media } : {}),
      ...(m.reactions.length ? { reactions: m.reactions.map(r => ({ emoji: r.emoji, by: r.by.map(u => person(u, users)) })) } : {}),
      ...(m.poll ? { poll: { question: m.poll.question, options: m.poll.options.map(o => ({ text: o.text, votes: o.votes.map(u => person(u, users)) })) } } : {}),
      ...(m.event ? { event: {
        name: m.event.name,
        ...(m.event.description ? { description: m.event.description } : {}),
        ...(m.event.start ? { start: formatDateTime(m.event.start, ctx.timezone) } : {}),
        ...(m.event.canceled ? { canceled: true } : {}),
        responses: {
          going: m.event.responses.going.map(u => person(u, users)),
          maybe: m.event.responses.maybe.map(u => person(u, users)),
          not_going: m.event.responses.not_going.map(u => person(u, users)),
        },
      } } : {}),
      ...(m.deleted ? { deleted: true, ...(m.deletedBy ? { deleted_by: { lid: m.deletedBy, ...(users.get(m.deletedBy)?.name ? { name: users.get(m.deletedBy)!.name } : {}) } } : {}) } : {}),
    }))
    return paginate('messages', rows, total, offset)
  },

  activity_stats(args, ctx) {
    const now = (ctx.nowMs ?? (() => Date.now()))()
    const jids = resolveJids(args.group_jids, ctx.scope)
    if (!Array.isArray(args.ranges) || args.ranges.length < 1 || args.ranges.length > 12) {
      throw new ToolError('ranges must contain between 1 and 12 {from, to} entries')
    }
    let participantLids: string[] | undefined
    if (args.participant_lids !== undefined) {
      if (!Array.isArray(args.participant_lids)) {
        throw new ToolError('participant_lids must be an array of member references')
      }
      participantLids = (args.participant_lids as unknown[]).length
        ? (args.participant_lids as unknown[]).map(l => resolvePersonRef(l, 'participant_lids'))
        : undefined
    }
    const CATS = ['primary', 'corrective', 'secondary'] as const
    let categories: Set<'primary' | 'corrective' | 'secondary'>
    if (args.categories === undefined) {
      categories = new Set(CATS)
    } else {
      if (!Array.isArray(args.categories) || (args.categories as unknown[]).some(c => !CATS.includes(c as never))) {
        throw new ToolError('categories entries must be primary, corrective or secondary')
      }
      categories = new Set(args.categories as ('primary' | 'corrective' | 'secondary')[])
      if (categories.size === 0) categories = new Set(CATS)
    }
    const todayStart = parseDateTime(formatDateTime(Math.floor(now / 1000), ctx.timezone).slice(0, 10), ctx.timezone, 'start')
    const ranges: QaStatsRange[] = (args.ranges as Record<string, unknown>[]).map(r => {
      const from = dt(ctx, r.from, 'start', NaN)
      const to = dt(ctx, r.to, 'end', NaN)
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ToolError('every range needs from and to datetimes')
      checkRange(from, to)
      return {
        from, to,
        watermarkFromDate: to >= todayStart ? formatDateTime(from, ctx.timezone).slice(0, 10) : null,
      }
    })
    const rows = qActivityStats({ groupJids: jids }, { participantLids, ranges, categories })
    const payload = {
      rows: rows.map(r => ({
        group_jid: r.groupJid,
        group_name: r.groupJid === 'total' ? 'total' : (ctx.scope.names.get(r.groupJid) ?? r.groupJid),
        range: { from: formatDateTime(r.range.from, ctx.timezone), to: formatDateTime(r.range.to, ctx.timezone) },
        counts: r.counts,
        ...(r.members ? { members: r.members } : {}),
      })),
    }
    const size = jsonBytes(payload)
    if (size > TOOL_RESULT_MAX_BYTES) throw new ToolError(sizeError(size))
    return payload
  },

  message_search(args, ctx) {
    const now = (ctx.nowMs ?? (() => Date.now()))()
    if (!Array.isArray(args.query) || args.query.length === 0 || (args.query as unknown[]).every(q => !String(q ?? '').trim())) {
      throw new ToolError('query must be a non-empty array of search strings')
    }
    const jids = resolveJids(args.group_jids, ctx.scope)
    let authorLid: string | undefined
    if (args.author_lid !== undefined) {
      authorLid = resolvePersonRef(args.author_lid, 'author_lid')
    }
    const from = dt(ctx, args.from, 'start', 0)
    const to = dt(ctx, args.to, 'end', Math.floor(now / 1000))
    checkRange(from, to)
    const order = args.order === 'asc' ? 'asc' : 'desc'
    const limit = clampLimit('message_search', args.limit)
    const offset = parseOffset(args.offset)
    const { hits, total } = qSearchMessages({ groupJids: jids }, {
      query: (args.query as unknown[]).map(String), authorLid, from, to, order, limit, offset,
    })
    const users = qUsersByJids([...new Set(hits.map(h => h.authorLid))])
    const rows = hits.map(h => ({
      message_id: h.messageId,
      group_jid: h.groupJid,
      group_name: ctx.scope.names.get(h.groupJid) ?? h.groupJid,
      sent_at: formatDateTime(h.timestamp, ctx.timezone),
      ...(users.get(h.authorLid)?.name ? { author_name: users.get(h.authorLid)!.name } : {}),
      snippet: h.snippet,
    }))
    return paginate('hits', rows, total, offset)
  },
}

export function toolExecutorNames(): string[] {
  return Object.keys(executors)
}

/** Run a tool. NEVER throws: every failure comes back as {"error": ...} JSON. */
export function executeQaTool(name: string, args: Record<string, unknown> | undefined, ctx: ToolExecCtx): { result: string; resultChars: number } {
  let payload: unknown
  try {
    const fn = executors[name]
    if (!fn) throw new ToolError(`Unknown tool: ${name}`)
    payload = fn(args ?? {}, ctx)
  } catch (err) {
    if (err instanceof ToolError) {
      payload = { error: err.message }
    } else {
      logger.error({ err, tool: name }, 'Tool execution failed')
      payload = { error: 'Tool execution failed unexpectedly' }
    }
  }
  const result = JSON.stringify(payload)
  return { result, resultChars: result.length }
}
