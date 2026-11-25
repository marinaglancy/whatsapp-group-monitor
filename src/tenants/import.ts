import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import { BOT_FUNCTION_QA, type GroupBotConfig } from '../db/schema.js'
import { QA_TRIGGER_DEFAULTS } from '../triggers/qa/defaults.js'
import { findConflicts, type EntryMap, type GroupMap } from './membership.js'

export interface LegacyQaGroup { jid: string; name: string; botFunctions: number; botConfig: GroupBotConfig | null; createdAt: number }
export interface IncomingTrigger { type: string; name: string; enabled: boolean; sortOrder: number; config: Record<string, unknown> }
export interface IncomingTenant { name: string; jids: string[]; triggers: IncomingTrigger[] }

/** One tenant per legacy Q&A group (Q&A bit on, or a bot_config.qa entry), oldest group first. */
export function convertLegacyQaGroups(groups: LegacyQaGroup[], legacyPrompt: string | null): IncomingTenant[] {
  return groups
    .filter(g => (g.botFunctions & BOT_FUNCTION_QA) !== 0 || !!g.botConfig?.qa)
    .sort((a, b) => a.createdAt - b.createdAt || (a.jid < b.jid ? -1 : a.jid > b.jid ? 1 : 0))
    .map(g => ({
      name: g.name,
      jids: [...new Set([g.jid, ...(g.botConfig?.qa?.linkedJids ?? [])])],
      triggers: [{
        type: 'qa',
        name: 'Q&A',
        enabled: (g.botFunctions & BOT_FUNCTION_QA) !== 0,
        sortOrder: 1,
        config: {
          ...QA_TRIGGER_DEFAULTS,
          qaGroupJid: g.jid,
          instructions: g.botConfig?.qa?.instructions ?? '',
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

function parseBotConfig(raw: string | null): GroupBotConfig | null {
  if (!raw) return null
  try { return JSON.parse(raw) as GroupBotConfig } catch { return null }
}

/** One-off conversion of the old Q&A group settings. Group jids already taken by an earlier tenant are skipped. */
export function migrateLegacyQaGroups(sqlite: Database.Database, legacyPrompt: string | null): { created: number; skippedJids: string[] } {
  const rows = sqlite.prepare('SELECT jid, name, bot_functions, bot_config, created_at FROM groups')
    .all() as { jid: string; name: string; bot_functions: number; bot_config: string | null; created_at: number }[]
  const legacy = convertLegacyQaGroups(rows.map(r => ({
    jid: r.jid, name: r.name, botFunctions: r.bot_functions, botConfig: parseBotConfig(r.bot_config), createdAt: r.created_at,
  })), legacyPrompt)

  const { entries, groups } = readMembershipSnapshot(sqlite)
  const skippedJids: string[] = []
  let created = 0
  for (const tenant of legacy) {
    const conflicts = findConflicts(null, tenant.jids, entries, groups)
    for (const jid of conflicts) {
      logger.warn({ jid, tenant: tenant.name }, 'Group already belongs to another tenant, left out of the converted Q&A tenant')
      skippedJids.push(jid)
    }
    const jids = tenant.jids.filter(j => !conflicts.includes(j))
    if (jids.length === 0) continue
    const id = insertIncomingTenant(sqlite, { ...tenant, jids })
    for (const jid of jids) entries.set(jid, id)
    created++
  }
  return { created, skippedJids }
}
