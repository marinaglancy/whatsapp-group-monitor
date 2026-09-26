import { sql, type SQL } from 'drizzle-orm'
import { getAccountDb } from '../account.js'

/** Typed query layer behind the Q&A tools. Everything here speaks unix seconds
 *  and raw jids; the executor layer converts to/from the model-visible
 *  formats (local datetimes, person strings). */

export interface QaToolQueryCtx {
  /** Concrete (non-community) group jids, already scope-resolved. */
  groupJids: string[]
}

const PRIMARY = ['message', 'poll_create', 'event_create'] as const
const SECONDARY = ['reaction', 'poll_vote', 'event_response'] as const

function inList(values: readonly string[]): SQL {
  return sql.join(values.map(v => sql`${v}`), sql`, `)
}

function bareId(jid: string): string {
  return jid.split(':')[0].split('@')[0]
}

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T } catch { return null }
  }
  return value as T
}

// --- group_members -----------------------------------------------------------

export interface QaMemberFilters {
  nameContains?: string
  phoneContains?: string
  lids?: string[]
  role?: 'participant' | 'admin' | 'superadmin'
  minActivityCount?: number
  maxActivityCount?: number
  lastActivityBefore?: number
  lastActivityAfter?: number
}

export interface QaMemberRow {
  lid: string
  name: string | null
  phone: string | null
  role: 'participant' | 'admin' | 'superadmin' | 'none'
  groups: string[] | null
  joinedAt: number | null
  leftAt: number | null
  lastRead: string | null
  activityCount: number
  lastActivity: number | null
}

const ROLE_LEVEL: Record<string, number> = { none: 1, pending_approval: 2, participant: 3, admin: 4, superadmin: 5 }
const LEVEL_ROLE: Record<number, QaMemberRow['role']> = { 1: 'none', 2: 'none', 3: 'participant', 4: 'admin', 5: 'superadmin' }

export function qGroupMembers(ctx: QaToolQueryCtx, opts: {
  groupJids?: string[]
  activityFrom: number
  activityTo: number
  filters: QaMemberFilters
  includeLeft: boolean
  orderBy: string
  order: 'asc' | 'desc'
  limit: number
  offset: number
  fields?: Set<string>
}): { members: QaMemberRow[]; total: number } {
  const db = getAccountDb()
  const jids = opts.groupJids?.length ? opts.groupJids : ctx.groupJids
  if (jids.length === 0) return { members: [], total: 0 }
  const f = opts.filters

  const conditions: SQL[] = []
  if (!opts.includeLeft) conditions.push(sql`m.lvl >= 3`)
  if (f.nameContains) conditions.push(sql`lower(coalesce(u.display_name, '')) LIKE ${'%' + f.nameContains.toLowerCase() + '%'}`)
  if (f.phoneContains) conditions.push(sql`coalesce(u.phone_number, '') LIKE ${'%' + f.phoneContains + '%'}`)
  if (f.lids?.length) conditions.push(sql`u.jid IN (${inList(f.lids)})`)
  if (f.role) conditions.push(sql`m.lvl = ${ROLE_LEVEL[f.role]}`)
  if (f.minActivityCount !== undefined) conditions.push(sql`coalesce(a.cnt, 0) >= ${f.minActivityCount}`)
  if (f.maxActivityCount !== undefined) conditions.push(sql`coalesce(a.cnt, 0) <= ${f.maxActivityCount}`)
  if (f.lastActivityBefore !== undefined) conditions.push(sql`(a.last_ts IS NULL OR a.last_ts < ${f.lastActivityBefore})`)
  if (f.lastActivityAfter !== undefined) conditions.push(sql`a.last_ts >= ${f.lastActivityAfter}`)
  const where = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``

  const orderExprs: Record<string, SQL> = {
    lid: sql`u.jid`,
    phone: sql`u.phone_number`,
    name: sql`u.display_name`,
    last_activity: sql`a.last_ts`,
    activity_count: sql`coalesce(a.cnt, 0)`,
    joined_at: sql`m.joined_at`,
  }
  const dir = opts.order === 'desc' ? sql`DESC` : sql`ASC`
  const orderExpr = orderExprs[opts.orderBy] ?? orderExprs.lid

  const bodySql = sql`
    FROM (
      SELECT gm.user_jid,
             max(CASE gm.membership WHEN 'superadmin' THEN 5 WHEN 'admin' THEN 4 WHEN 'participant' THEN 3 WHEN 'pending_approval' THEN 2 ELSE 1 END) AS lvl,
             group_concat(CASE WHEN gm.membership NOT IN ('none') THEN gm.group_jid END) AS grps,
             min(gm.joined_at) AS joined_at,
             max(gm.left_at) AS left_at,
             max(gm.last_read_at) AS last_read
      FROM group_members gm
      WHERE gm.group_jid IN (${inList(jids)})
      GROUP BY gm.user_jid
    ) m
    JOIN users u ON u.jid = m.user_jid
    LEFT JOIN (
      SELECT user_jid, count(*) AS cnt, max(timestamp) AS last_ts
      FROM group_activity_log
      WHERE group_jid IN (${inList(jids)})
        AND timestamp BETWEEN ${opts.activityFrom} AND ${opts.activityTo}
        AND event_type IN (${inList([...PRIMARY, ...SECONDARY])})
        AND NOT (event_type = 'reaction' AND json_extract(metadata, '$.emoji') IS NULL)
      GROUP BY user_jid
    ) a ON a.user_jid = m.user_jid
    ${where}`

  const totalRow = db.get<{ cnt: number }>(sql`SELECT count(*) AS cnt ${bodySql}`)
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT u.jid AS lid, u.display_name AS name, u.phone_number AS phone,
           m.lvl AS lvl, m.grps AS grps, m.joined_at AS joined_at, m.left_at AS left_at, m.last_read AS last_read,
           coalesce(a.cnt, 0) AS activity_count, a.last_ts AS last_activity
    ${bodySql}
    ORDER BY ${orderExpr} ${dir}, u.jid ${dir}
    LIMIT ${opts.limit} OFFSET ${opts.offset}`)

  const members: QaMemberRow[] = rows.map(r => ({
    lid: r.lid as string,
    name: (r.name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    role: LEVEL_ROLE[r.lvl as number] ?? 'none',
    groups: r.grps ? (r.grps as string).split(',').sort() : null,
    joinedAt: r.joined_at ? Math.floor((r.joined_at as number) / 1000) : null,
    leftAt: r.left_at ? Math.floor((r.left_at as number) / 1000) : null,
    lastRead: (r.last_read as string | null) ?? null,
    activityCount: r.activity_count as number,
    lastActivity: (r.last_activity as number | null) ?? null,
  }))
  return { members, total: totalRow?.cnt ?? 0 }
}

// --- group_messages ----------------------------------------------------------

export interface QaMessageRow {
  messageId: string
  groupJid: string
  authorLid: string
  timestamp: number
  type: 'message' | 'poll' | 'event'
  text: string | null
  edited: boolean
  replyToId: string | null
  media: string | null
  reactions: { emoji: string; by: string[] }[]
  poll: { question: string; options: { text: string; votes: string[] }[] } | null
  event: { name: string; description: string | null; start: number | null; canceled: boolean; responses: { going: string[]; maybe: string[]; not_going: string[] } } | null
  deleted?: boolean
  deletedBy?: string
}

const BASE_TYPE_BY_KIND: Record<string, string> = { message: 'message', poll: 'poll_create', event: 'event_create' }
const KIND_BY_BASE_TYPE: Record<string, QaMessageRow['type']> = { message: 'message', poll_create: 'poll', event_create: 'event' }

export function mediaIndication(metadata: Record<string, unknown> | null, raw: Record<string, unknown> | null): string | null {
  const ct = metadata?.contentType as string | undefined
  const rawMsg = (raw?.message ?? {}) as Record<string, Record<string, unknown>>
  switch (ct) {
    case undefined:
    case 'conversation':
    case 'extendedTextMessage':
    case 'pinInChatMessage':
      return null
    case 'imageMessage': return 'image'
    case 'videoMessage': return 'video'
    case 'stickerMessage': return 'sticker'
    case 'audioMessage': return rawMsg.audioMessage?.ptt ? 'voice message' : 'audio'
    case 'documentMessage': {
      const fn = rawMsg.documentMessage?.fileName
      return fn ? `document: ${fn}` : 'document'
    }
    case 'locationMessage': return 'location'
    case 'liveLocationMessage': return 'live location'
    case 'contactMessage': return 'contact'
    case 'contactsArrayMessage': return 'contacts'
    default: return ct
  }
}

export function qGroupMessages(ctx: QaToolQueryCtx, opts: {
  groupJids?: string[]
  from: number
  to: number
  types?: string[]
  memberLid?: string
  memberPhone?: string | null
  hasReactions?: boolean
  includeDeleted: boolean
  order: 'asc' | 'desc'
  limit: number
  offset: number
}): { messages: QaMessageRow[]; total: number; hasMoreRows: boolean } {
  const db = getAccountDb()
  const jids = opts.groupJids?.length ? opts.groupJids : ctx.groupJids
  if (jids.length === 0) return { messages: [], total: 0, hasMoreRows: false }

  const baseTypes = (opts.types?.length ? opts.types : ['message', 'poll', 'event'])
    .map(t => BASE_TYPE_BY_KIND[t]).filter(Boolean)
  const conditions: SQL[] = [
    sql`base.group_jid IN (${inList(jids)})`,
    sql`base.event_type IN (${inList(baseTypes)})`,
    sql`base.timestamp BETWEEN ${opts.from} AND ${opts.to}`,
  ]
  if (!opts.includeDeleted) {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM group_activity_log d
      WHERE d.group_jid = base.group_jid AND d.parent_id = base.message_id AND d.event_type = 'delete')`)
  }
  if (opts.hasReactions) {
    // approximation: received a real reaction at some point (later removals may
    // have cleared it — resolving live state per row in SQL is not worth it)
    conditions.push(sql`EXISTS (SELECT 1 FROM group_activity_log rc
      WHERE rc.group_jid = base.group_jid AND rc.parent_id = base.message_id
        AND rc.event_type = 'reaction' AND json_extract(rc.metadata, '$.emoji') IS NOT NULL)`)
  }
  if (opts.memberLid) {
    const lid = opts.memberLid
    const lidDigits = bareId(lid)
    const legs: SQL[] = [
      sql`base.user_jid = ${lid}`,
      sql`EXISTS (SELECT 1 FROM group_activity_log c
        WHERE c.group_jid = base.group_jid AND c.parent_id = base.message_id AND c.user_jid = ${lid}
          AND c.event_type IN ('message', 'edit', 'reaction', 'poll_vote', 'event_response', 'delete'))`,
      sql`(base.parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM group_activity_log p
        WHERE p.group_jid = base.group_jid AND p.message_id = base.parent_id AND p.user_jid = ${lid}))`,
      sql`json_extract(base.metadata, '$.mentions') LIKE ${'%"' + lid + '"%'}`,
      sql`json_extract(base.metadata, '$.text') LIKE ${'%@' + lidDigits + '%'}`,
    ]
    if (opts.memberPhone) {
      legs.push(sql`json_extract(base.metadata, '$.mentions') LIKE ${'%"' + opts.memberPhone + '@s.whatsapp.net"%'}`)
      legs.push(sql`json_extract(base.metadata, '$.text') LIKE ${'%@' + opts.memberPhone + '%'}`)
    }
    conditions.push(sql`(${sql.join(legs, sql` OR `)})`)
  }
  const where = sql`WHERE ${sql.join(conditions, sql` AND `)}`
  const dir = opts.order === 'desc' ? sql`DESC` : sql`ASC`

  const totalRow = db.get<{ cnt: number }>(sql`SELECT count(*) AS cnt FROM group_activity_log base ${where}`)
  const total = totalRow?.cnt ?? 0
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT base.id, base.group_jid, base.user_jid, base.message_id, base.parent_id, base.event_type,
           base.metadata, base.raw, base.timestamp
    FROM group_activity_log base ${where}
    ORDER BY base.timestamp ${dir}, base.id ${dir}
    LIMIT ${opts.limit} OFFSET ${opts.offset}`)

  const ids = rows.map(r => r.message_id as string)
  const children = ids.length
    ? db.all<Record<string, unknown>>(sql`
        SELECT id, group_jid, user_jid, message_id, parent_id, event_type, metadata, timestamp
        FROM group_activity_log
        WHERE group_jid IN (${inList(jids)}) AND parent_id IN (${inList(ids)})
          AND event_type IN ('edit', 'reaction', 'poll_vote', 'event_response', 'delete')
        ORDER BY id`)
    : []
  const childByParent = new Map<string, Record<string, unknown>[]>()
  for (const c of children) {
    const key = `${c.group_jid}|${c.parent_id}`
    if (!childByParent.has(key)) childByParent.set(key, [])
    childByParent.get(key)!.push(c)
  }

  const messages: QaMessageRow[] = rows.map(r => {
    const meta = parseJson<Record<string, unknown>>(r.metadata) ?? {}
    const raw = parseJson<Record<string, unknown>>(r.raw)
    const kind = KIND_BY_BASE_TYPE[r.event_type as string]
    const kids = childByParent.get(`${r.group_jid}|${r.message_id}`) ?? []

    let text = (meta.text as string | undefined) ?? null
    let edited = false
    // per-user LAST reaction (children are id-ordered): null/empty = removed
    const reactionByUser = new Map<string, string | null>()
    const votesByUser = new Map<string, string[]>()
    const responseByUser = new Map<string, string>()
    let deleted = false
    let deletedBy: string | undefined

    for (const c of kids) {
      const cmeta = parseJson<Record<string, unknown>>(c.metadata) ?? {}
      switch (c.event_type) {
        case 'edit': {
          const t = cmeta.text as string | undefined
          if (t) { text = t; edited = true }
          break
        }
        case 'reaction':
          reactionByUser.set(c.user_jid as string, (cmeta.emoji as string | null) || null)
          break
        case 'poll_vote':
          votesByUser.set(c.user_jid as string, (cmeta.selectedOptions as string[] | undefined) ?? [])
          break
        case 'event_response':
          if (cmeta.response) responseByUser.set(c.user_jid as string, cmeta.response as string)
          break
        case 'delete':
          if (!deleted) { deleted = true; deletedBy = c.user_jid as string }
          break
      }
    }

    const reactionsByEmoji = new Map<string, string[]>()
    for (const [user, emoji] of reactionByUser) {
      if (!emoji) continue // removed their reaction
      if (!reactionsByEmoji.has(emoji)) reactionsByEmoji.set(emoji, [])
      reactionsByEmoji.get(emoji)!.push(user)
    }

    let poll: QaMessageRow['poll'] = null
    if (kind === 'poll') {
      const optionNames = (meta.options as string[] | undefined) ?? []
      poll = {
        question: (meta.question as string | undefined) ?? '',
        options: optionNames.map(name => ({
          text: name,
          votes: [...votesByUser.entries()].filter(([, sel]) => sel.includes(name)).map(([u]) => u),
        })),
      }
    }

    let event: QaMessageRow['event'] = null
    if (kind === 'event') {
      const responses = { going: [] as string[], maybe: [] as string[], not_going: [] as string[] }
      for (const [user, resp] of responseByUser) {
        if (resp === 'GOING') responses.going.push(user)
        else if (resp === 'MAYBE') responses.maybe.push(user)
        else if (resp === 'NOT_GOING') responses.not_going.push(user)
      }
      event = {
        name: (meta.name as string | undefined) ?? '',
        description: (meta.description as string | null | undefined) ?? null,
        start: (meta.startTime as number | null | undefined) ?? null,
        canceled: !!meta.isCanceled,
        responses,
      }
    }

    return {
      messageId: r.message_id as string,
      groupJid: r.group_jid as string,
      authorLid: r.user_jid as string,
      timestamp: r.timestamp as number,
      type: kind,
      text,
      edited,
      replyToId: (r.parent_id as string | null) ?? null,
      media: kind === 'message' ? mediaIndication(meta, raw) : null,
      reactions: [...reactionsByEmoji.entries()].map(([emoji, by]) => ({ emoji, by })),
      poll,
      event,
      ...(deleted ? { deleted: true, deletedBy } : {}),
    }
  })

  return { messages, total, hasMoreRows: opts.offset + messages.length < total }
}

// --- activity_stats ----------------------------------------------------------

export interface QaStatsRange {
  from: number
  to: number
  /** Local 'YYYY-MM-DD' the read watermark must reach; null = participants not computable (past range). */
  watermarkFromDate?: string | null
}

export interface QaStatsRow {
  groupJid: string
  range: { from: number; to: number }
  counts: {
    primary?: { messages: number; polls: number; events: number }
    corrective?: { edits: number; own_deletes: number }
    secondary?: { reactions: number; poll_votes: number; event_responses: number }
  }
  members?: {
    contributors: number
    engagers: number
    participants?: number
    joined: number
    left: number
    total: number
  }
}

export function qActivityStats(ctx: QaToolQueryCtx, opts: {
  groupJids?: string[]
  participantLids?: string[]
  ranges: QaStatsRange[]
  categories: Set<'primary' | 'corrective' | 'secondary'>
}): QaStatsRow[] {
  const db = getAccountDb()
  const jids = opts.groupJids?.length ? opts.groupJids : ctx.groupJids
  if (jids.length === 0) return []
  const lids = opts.participantLids
  const includeMembers = !(lids && lids.length === 1)
  const participantCond = lids?.length ? sql` AND base.user_jid IN (${inList(lids)})` : sql``
  const memberParticipantCond = lids?.length ? sql` AND gm.user_jid IN (${inList(lids)})` : sql``

  const statsSelect = sql`
    sum(CASE WHEN base.event_type = 'message' THEN 1 ELSE 0 END) AS messages,
    sum(CASE WHEN base.event_type = 'poll_create' THEN 1 ELSE 0 END) AS polls,
    sum(CASE WHEN base.event_type = 'event_create' THEN 1 ELSE 0 END) AS events,
    sum(CASE WHEN base.event_type = 'edit' THEN 1 ELSE 0 END) AS edits,
    sum(CASE WHEN base.event_type = 'delete' AND EXISTS (
      SELECT 1 FROM group_activity_log p
      WHERE p.group_jid = base.group_jid AND p.message_id = base.parent_id AND p.user_jid = base.user_jid
    ) THEN 1 ELSE 0 END) AS own_deletes,
    sum(CASE WHEN base.event_type = 'reaction' AND json_extract(base.metadata, '$.emoji') IS NOT NULL THEN 1 ELSE 0 END) AS reactions,
    sum(CASE WHEN base.event_type = 'poll_vote' THEN 1 ELSE 0 END) AS poll_votes,
    sum(CASE WHEN base.event_type = 'event_response' THEN 1 ELSE 0 END) AS event_responses,
    count(DISTINCT CASE WHEN base.event_type IN (${inList(PRIMARY)}) THEN base.user_jid END) AS contributors,
    count(DISTINCT CASE WHEN base.event_type IN (${inList(PRIMARY)}) OR base.event_type IN ('poll_vote', 'event_response')
      OR (base.event_type = 'reaction' AND json_extract(base.metadata, '$.emoji') IS NOT NULL)
      THEN base.user_jid END) AS engagers,
    sum(CASE WHEN base.event_type = 'member_joined' THEN 1 ELSE 0 END) AS joined_cnt,
    sum(CASE WHEN base.event_type = 'member_left' THEN 1 ELSE 0 END) AS left_cnt`

  function buildRow(groupJid: string, range: QaStatsRange, agg: Record<string, unknown> | undefined, memberTotal: number, participants: number | undefined): QaStatsRow {
    const n = (k: string) => Number((agg?.[k] as number | null) ?? 0)
    const counts: QaStatsRow['counts'] = {}
    if (opts.categories.has('primary')) counts.primary = { messages: n('messages'), polls: n('polls'), events: n('events') }
    if (opts.categories.has('corrective')) counts.corrective = { edits: n('edits'), own_deletes: n('own_deletes') }
    if (opts.categories.has('secondary')) counts.secondary = { reactions: n('reactions'), poll_votes: n('poll_votes'), event_responses: n('event_responses') }
    const row: QaStatsRow = { groupJid, range: { from: range.from, to: range.to }, counts }
    if (includeMembers) {
      row.members = {
        contributors: n('contributors'),
        engagers: n('engagers'),
        ...(participants !== undefined ? { participants } : {}),
        joined: n('joined_cnt'),
        left: n('left_cnt'),
        total: memberTotal,
      }
    }
    return row
  }

  // current member totals (per group and distinct across groups)
  const totals = db.all<{ group_jid: string; cnt: number }>(sql`
    SELECT gm.group_jid, count(*) AS cnt FROM group_members gm
    WHERE gm.group_jid IN (${inList(jids)}) AND gm.membership NOT IN ('none')${memberParticipantCond}
    GROUP BY gm.group_jid`)
  const totalByGroup = new Map(totals.map(t => [t.group_jid, t.cnt]))
  const distinctTotal = db.get<{ cnt: number }>(sql`
    SELECT count(DISTINCT gm.user_jid) AS cnt FROM group_members gm
    WHERE gm.group_jid IN (${inList(jids)}) AND gm.membership NOT IN ('none')${memberParticipantCond}`)?.cnt ?? 0

  const out: QaStatsRow[] = []
  for (const range of opts.ranges) {
    const perGroup = db.all<Record<string, unknown>>(sql`
      SELECT base.group_jid AS group_jid, ${statsSelect}
      FROM group_activity_log base
      WHERE base.group_jid IN (${inList(jids)}) AND base.timestamp BETWEEN ${range.from} AND ${range.to}${participantCond}
      GROUP BY base.group_jid`)
    const aggByGroup = new Map(perGroup.map(r => [r.group_jid as string, r]))

    const participantsByGroup = new Map<string, number>()
    let participantsAll: number | undefined
    if (includeMembers && range.watermarkFromDate) {
      // funnel top: participants = engagers (activity implies presence) UNION the
      // read-receipt watermark members
      const readerUnion = sql`
        SELECT base.group_jid AS gj, base.user_jid AS jid
        FROM group_activity_log base
        WHERE base.group_jid IN (${inList(jids)}) AND base.timestamp BETWEEN ${range.from} AND ${range.to}
          AND (base.event_type IN (${inList([...PRIMARY, 'poll_vote', 'event_response'])})
            OR (base.event_type = 'reaction' AND json_extract(base.metadata, '$.emoji') IS NOT NULL))${participantCond}
        UNION
        SELECT gm.group_jid AS gj, gm.user_jid AS jid FROM group_members gm
        WHERE gm.group_jid IN (${inList(jids)}) AND gm.membership NOT IN ('none')
          AND gm.last_read_at >= ${range.watermarkFromDate}${memberParticipantCond}`
      const rrows = db.all<{ gj: string; cnt: number }>(sql`
        SELECT x.gj, count(DISTINCT x.jid) AS cnt FROM (${readerUnion}) x GROUP BY x.gj`)
      for (const r of rrows) participantsByGroup.set(r.gj, r.cnt)
      participantsAll = db.get<{ cnt: number }>(sql`
        SELECT count(DISTINCT x.jid) AS cnt FROM (${readerUnion}) x`)?.cnt ?? 0
    }

    for (const jid of jids) {
      out.push(buildRow(jid, range, aggByGroup.get(jid), totalByGroup.get(jid) ?? 0,
        range.watermarkFromDate ? (participantsByGroup.get(jid) ?? 0) : undefined))
    }
    if (jids.length > 1) {
      const all = db.get<Record<string, unknown>>(sql`
        SELECT ${statsSelect}
        FROM group_activity_log base
        WHERE base.group_jid IN (${inList(jids)}) AND base.timestamp BETWEEN ${range.from} AND ${range.to}${participantCond}`)
      out.push(buildRow('total', range, all ?? undefined, distinctTotal,
        range.watermarkFromDate ? participantsAll : undefined))
    }
  }
  return out
}

// --- shared lookups ----------------------------------------------------------

/** Resolve a person reference the model may give in any of the forms it has
 *  seen — a full jid, bare lid digits, or a phone number — to the stored jid. */
export function qFindUserJid(ref: string): string | null {
  if (ref.includes('@')) return ref
  const db = getAccountDb()
  const row = db.get<{ jid: string }>(sql`
    SELECT jid FROM users
    WHERE jid = ${ref + '@lid'} OR jid = ${ref + '@s.whatsapp.net'} OR phone_number = ${ref}
    ORDER BY CASE WHEN jid LIKE '%@lid' THEN 0 ELSE 1 END
    LIMIT 1`)
  return row?.jid ?? null
}

/** Batch name/phone lookup for building person strings in the executor layer. */
export function qUsersByJids(jids: string[]): Map<string, { name: string | null; phone: string | null }> {
  if (!jids.length) return new Map()
  const db = getAccountDb()
  const rows = db.all<{ jid: string; name: string | null; phone: string | null }>(sql`
    SELECT jid, display_name AS name, phone_number AS phone FROM users WHERE jid IN (${inList(jids)})`)
  return new Map(rows.map(r => [r.jid, { name: r.name, phone: r.phone }]))
}

// --- message_search ----------------------------------------------------------

export function buildFtsMatch(query: string[]): string | null {
  const groups: string[] = []
  for (const entry of query) {
    const phrases: string[] = []
    const rest = String(entry).replace(/"([^"]*)"/g, (_m, p: string) => {
      const trimmed = p.trim()
      if (trimmed) phrases.push(`"${trimmed.replace(/"/g, ' ')}"`)
      return ' '
    })
    const words = rest.split(/\s+/).filter(Boolean).map(w => `"${w.replace(/"/g, '')}"`)
    const parts = [...words, ...phrases]
    if (parts.length) groups.push(`(${parts.join(' AND ')})`)
  }
  return groups.length ? groups.join(' OR ') : null
}

export interface QaSearchHit {
  messageId: string
  groupJid: string
  authorLid: string
  timestamp: number
  snippet: string
}

export function qSearchMessages(ctx: QaToolQueryCtx, opts: {
  groupJids?: string[]
  query: string[]
  authorLid?: string
  from: number
  to: number
  order: 'asc' | 'desc'
  limit: number
  offset: number
}): { hits: QaSearchHit[]; total: number } {
  const db = getAccountDb()
  const jids = opts.groupJids?.length ? opts.groupJids : ctx.groupJids
  if (jids.length === 0) return { hits: [], total: 0 }
  const match = buildFtsMatch(opts.query)
  if (!match) return { hits: [], total: 0 }

  const authorCond = opts.authorLid ? sql` AND t.user_jid = ${opts.authorLid}` : sql``
  const dir = opts.order === 'desc' ? sql`DESC` : sql`ASC`
  const joins = sql`
    FROM messages_fts f
    JOIN group_activity_log h ON h.id = f.rowid
    JOIN group_activity_log t
      ON t.group_jid = h.group_jid
     AND t.message_id = CASE WHEN h.event_type = 'edit' THEN h.parent_id ELSE h.message_id END
     AND t.event_type IN ('message', 'poll_create', 'event_create')
    WHERE messages_fts MATCH ${match}
      AND t.group_jid IN (${inList(jids)})
      AND t.timestamp BETWEEN ${opts.from} AND ${opts.to}${authorCond}
      AND NOT EXISTS (SELECT 1 FROM group_activity_log del
        WHERE del.group_jid = t.group_jid AND del.parent_id = t.message_id AND del.event_type = 'delete')`

  const total = db.get<{ cnt: number }>(sql`SELECT count(DISTINCT t.id) AS cnt ${joins}`)?.cnt ?? 0
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT t.message_id AS message_id, t.group_jid AS group_jid, t.user_jid AS user_jid, t.timestamp AS ts,
           json_extract(h.metadata, '$.text') AS hit_text
    ${joins}
    GROUP BY t.id
    ORDER BY t.timestamp ${dir}, t.id ${dir}
    LIMIT ${opts.limit} OFFSET ${opts.offset}`)

  return {
    hits: rows.map(r => ({
      messageId: r.message_id as string,
      groupJid: r.group_jid as string,
      authorLid: r.user_jid as string,
      timestamp: r.ts as number,
      snippet: makeSnippet((r.hit_text as string | null) ?? '', opts.query),
    })),
    total,
  }
}

/** Short excerpt around the first matched term (SQL snippet() misbehaves once
 *  the FTS table is joined, so this is done in JS over the hit row's text). */
function makeSnippet(text: string, query: string[], width = 100): string {
  const terms: string[] = []
  for (const entry of query) {
    const rest = String(entry).replace(/"([^"]*)"/g, (_m, p: string) => {
      if (p.trim()) terms.push(p.trim())
      return ' '
    })
    for (const w of rest.split(/\s+/)) if (w) terms.push(w)
  }
  const lower = text.toLowerCase()
  let idx = -1
  for (const term of terms) {
    const i = lower.indexOf(term.toLowerCase())
    if (i >= 0 && (idx < 0 || i < idx)) idx = i
  }
  if (idx < 0) return text.length > width ? text.slice(0, width) + '…' : text
  const start = Math.max(0, idx - Math.floor(width / 3))
  const end = Math.min(text.length, start + width)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}
