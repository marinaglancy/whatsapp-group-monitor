import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import { BOT_FUNCTION_QA, type GroupBotConfig } from '../db/schema.js'
import { QA_TRIGGER_DEFAULTS } from '../triggers/qa/defaults.js'
import { ERROR_TEXT } from '../triggers/errors.js'
import { findConflicts, type EntryMap, type GroupMap } from './membership.js'

export interface LegacyQaGroup { jid: string; name: string; botFunctions: number; botConfig: GroupBotConfig | null; createdAt: number }
export interface IncomingTrigger { type: string; name: string; enabled: boolean; sortOrder: number; config: Record<string, unknown> }
export interface IncomingTenant { name: string; jids: string[]; triggers: IncomingTrigger[] }

type LegacyQa = { linkedJids: string[]; instructions: string }

/** The group's old Q&A settings, with anything malformed left out (and logged). null = no usable qa entry. */
function readLegacyQa(g: LegacyQaGroup): LegacyQa | null {
  const qa: unknown = g.botConfig?.qa
  if (qa === undefined || qa === null) return null
  if (typeof qa !== 'object' || Array.isArray(qa)) {
    logger.warn({ jid: g.jid }, 'Ignoring malformed Q&A settings of an old Q&A group')
    return null
  }
  const { linkedJids, instructions } = qa as { linkedJids?: unknown; instructions?: unknown }
  let linked: string[] = []
  if (linkedJids !== undefined) {
    if (Array.isArray(linkedJids)) {
      linked = linkedJids.filter((j): j is string => typeof j === 'string' && j !== '')
    }
    if (!Array.isArray(linkedJids) || linked.length !== linkedJids.length) {
      logger.warn({ jid: g.jid }, 'Ignoring malformed linked groups of an old Q&A group')
    }
  }
  if (instructions !== undefined && typeof instructions !== 'string') {
    logger.warn({ jid: g.jid }, 'Ignoring malformed instructions of an old Q&A group')
  }
  return { linkedJids: linked, instructions: typeof instructions === 'string' ? instructions : '' }
}

/** One tenant per legacy Q&A group (Q&A bit on, or a bot_config.qa entry): groups with the Q&A bit on first, then oldest first. */
export function convertLegacyQaGroups(groups: LegacyQaGroup[], legacyPrompt: string | null): IncomingTenant[] {
  return groups
    .map(g => ({ g, qa: readLegacyQa(g) }))
    .filter(({ g, qa }) => (g.botFunctions & BOT_FUNCTION_QA) !== 0 || qa !== null)
    .sort((x, y) => Number((y.g.botFunctions & BOT_FUNCTION_QA) !== 0) - Number((x.g.botFunctions & BOT_FUNCTION_QA) !== 0) ||
      x.g.createdAt - y.g.createdAt || (x.g.jid < y.g.jid ? -1 : x.g.jid > y.g.jid ? 1 : 0))
    .map(({ g, qa }) => ({
      name: g.name,
      jids: [...new Set([g.jid, ...(qa?.linkedJids ?? [])])],
      triggers: [{
        type: 'qa',
        name: 'Q&A',
        enabled: (g.botFunctions & BOT_FUNCTION_QA) !== 0,
        sortOrder: 1,
        config: {
          ...QA_TRIGGER_DEFAULTS,
          qaGroupJid: g.jid,
          instructions: qa?.instructions ?? '',
          prompt: legacyPrompt?.trim() ? legacyPrompt : '',
        },
      }],
    }))
}

/** tenant_groups entries and the group tree of one database (`schema`: 'main' or an attached name). */
export function readMembershipSnapshot(sqlite: Database.Database, schema = 'main'): { entries: EntryMap; groups: GroupMap } {
  const entryRows = sqlite.prepare(`SELECT jid, tenant_id FROM ${schema}.tenant_groups`).all() as { jid: string; tenant_id: number }[]
  const groupRows = sqlite.prepare(`SELECT jid, parent_community_jid, is_community FROM ${schema}.groups`)
    .all() as { jid: string; parent_community_jid: string | null; is_community: number }[]
  return {
    entries: new Map(entryRows.map(r => [r.jid, r.tenant_id])),
    groups: new Map(groupRows.map(r => [r.jid, {
      jid: r.jid, parentCommunityJid: r.parent_community_jid, isCommunity: r.is_community !== 0,
    }])),
  }
}

/** Inserts the tenant, its group entries and triggers in one transaction; returns the new tenant id. */
export function insertIncomingTenant(sqlite: Database.Database, t: IncomingTenant): number {
  const now = Date.now()
  return sqlite.transaction(() => {
    const id = Number(sqlite.prepare('INSERT INTO tenants (name, created_at, updated_at) VALUES (?, ?, ?)')
      .run(t.name, now, now).lastInsertRowid)
    const addJid = sqlite.prepare('INSERT INTO tenant_groups (jid, tenant_id) VALUES (?, ?)')
    for (const jid of t.jids) addJid.run(jid, id)
    const addTrigger = sqlite.prepare(`INSERT INTO bot_triggers
      (tenant_id, type, name, enabled, sort_order, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const tr of t.triggers) {
      addTrigger.run(id, tr.type, tr.name, tr.enabled ? 1 : 0, tr.sortOrder, JSON.stringify(tr.config), now, now)
    }
    return id
  })()
}

function parseBotConfig(raw: string | null, jid: string): GroupBotConfig | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { parsed = undefined }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn({ jid }, 'Ignoring unreadable bot_config of a group')
    return null
  }
  return parsed as GroupBotConfig
}

/** One-off conversion of the old Q&A group settings. Group jids already taken by an earlier tenant are skipped. */
export function migrateLegacyQaGroups(sqlite: Database.Database, legacyPrompt: string | null): { created: number; skippedJids: string[] } {
  const rows = sqlite.prepare('SELECT jid, name, bot_functions, bot_config, created_at FROM groups')
    .all() as { jid: string; name: string; bot_functions: number; bot_config: string | null; created_at: number }[]
  const legacy = convertLegacyQaGroups(rows.map(r => ({
    jid: r.jid, name: r.name, botFunctions: r.bot_functions, botConfig: parseBotConfig(r.bot_config, r.jid), createdAt: r.created_at,
  })), legacyPrompt)

  const { entries, groups } = readMembershipSnapshot(sqlite)
  const tenantName = sqlite.prepare('SELECT name FROM tenants WHERE id = ?')
  const skippedJids: string[] = []
  let created = 0
  for (const tenant of legacy) {
    const conflicts = findConflicts(null, tenant.jids, entries, groups)
    const qaJid = String(tenant.triggers[0].config.qaGroupJid)
    // Only the tenant's own groups count; community children it never listed are not reported.
    for (const jid of conflicts.filter(j => tenant.jids.includes(j))) {
      if (jid === qaJid) {
        logger.warn({ jid, tenant: tenant.name }, 'The Q&A group already belongs to another tenant: questions in that group will not be answered until the tenant is fixed')
      } else {
        logger.warn({ jid, tenant: tenant.name }, 'Group already belongs to another tenant, left out of the converted Q&A tenant')
      }
      skippedJids.push(jid)
    }
    const jids = tenant.jids.filter(j => !conflicts.includes(j))
    // A community brings all its groups, but one already in an earlier tenant stays there.
    for (const jid of conflicts.filter(j => !tenant.jids.includes(j))) {
      const community = groups.get(jid)?.parentCommunityJid
      if (!community || !jids.includes(community)) continue
      const earlier = tenantName.get(entries.get(jid)) as { name: string } | undefined
      logger.warn({ jid, community, tenant: tenant.name, earlierTenant: earlier?.name ?? '?' },
        'A group of the converted community already belongs to an earlier tenant: it stays with the earlier tenant')
    }
    if (!jids.some(j => j !== qaJid)) {
      logger.warn({ tenant: tenant.name }, `The converted tenant has no group besides its Q&A group: its questions will get "${ERROR_TEXT.noOtherGroups}"`)
    }
    const id = insertIncomingTenant(sqlite, { ...tenant, jids })
    for (const jid of jids) entries.set(jid, id)
    created++
  }
  return { created, skippedJids }
}
